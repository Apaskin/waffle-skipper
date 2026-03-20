// claude.ts — Claude API client + the confidence-scoring system prompt.
// This is the single place that calls the Anthropic API. The prompt is
// versioned via PROMPT_VERSION so we can invalidate the shared cache
// when the prompt improves.

import type { Env } from '../index';

export interface TranscriptChunk {
  start: number;
  end: number;
  text: string;
}

export interface ScoredSegment {
  start: number;
  end: number;
  waffle_confidence: number;
  category: string;
  label: string;
}

// The exact system prompt. Changes here MUST be accompanied by a
// PROMPT_VERSION bump in wrangler.toml so stale cache entries are
// bypassed and re-analysed with the new prompt.
const SYSTEM_PROMPT = `You analyse YouTube video transcripts to detect filler content ("waffle").

For each segment, return a waffle_confidence score from 0-100:
- 90-100: Definite waffle — sponsor reads, ad segments, "like and subscribe" pleas, merch/patreon plugs
- 70-89: Strong waffle — completely off-topic tangents, repeated information already covered, extended "before we begin" padding
- 50-69: Probable waffle — personal anecdotes loosely related to topic, overly long examples, slow preamble
- 30-49: Borderline — context-setting that some viewers want, entertaining tangents that circle back, background information
- 10-29: Mostly substance — relevant with minor digressions
- 0-9: Pure substance — core content, key arguments, instructions, insights

Also classify each segment's category: "sponsor", "self_promo", "tangent", "filler", "repetition", "intro_outro", "substance"

Respond ONLY with a JSON array, no other text:
[{"start": 0, "end": 30, "waffle_confidence": 85, "category": "intro_outro", "label": "Extended intro with channel branding"}, ...]

Be precise with timestamps. Every second of the video must be covered — no gaps between segments. Adjacent segments with the same classification should be merged.`;

// Model fallback candidates — try each in order until one works
const MODEL_CANDIDATES = [
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-latest',
  'claude-3-5-haiku-latest',
];

/**
 * Send transcript chunks to Claude and get back confidence-scored segments.
 * Handles model fallback and response parsing.
 */
export async function classifyTranscript(
  chunks: TranscriptChunk[],
  env: Env
): Promise<ScoredSegment[]> {
  const BATCH_SIZE = 40;
  const allSegments: ScoredSegment[] = [];

  // Process in batches of 40 chunks to stay within context limits
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchResult = await classifyBatch(batch, env);
    allSegments.push(...batchResult);
  }

  // Merge adjacent segments with same category and similar confidence
  return mergeAdjacentSegments(allSegments);
}

async function classifyBatch(
  chunks: TranscriptChunk[],
  env: Env
): Promise<ScoredSegment[]> {
  // Build the user message with numbered segments
  const chunkText = chunks
    .map(
      (c, i) =>
        `Segment ${i + 1} [${fmtTime(c.start)} - ${fmtTime(c.end)}]:\n${c.text}`
    )
    .join('\n\n');

  const userMessage = `Classify each segment:\n\n${chunkText}`;

  // Try each model candidate until one succeeds
  let lastError: Error | null = null;

  for (const model of MODEL_CANDIDATES) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        // If model not found, try the next candidate
        if (
          response.status === 404 ||
          errText.toLowerCase().includes('not found') ||
          errText.toLowerCase().includes('does not exist')
        ) {
          lastError = new Error(`Model ${model} unavailable`);
          continue;
        }
        throw new Error(`Claude API ${response.status}: ${errText}`);
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };

      const text = (data.content || [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
        .trim();

      if (!text) throw new Error('Empty Claude response');

      return parseSegments(text);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only continue to next model on model-availability errors
      if (!lastError.message.includes('unavailable')) throw lastError;
    }
  }

  throw lastError || new Error('All model candidates failed');
}

/**
 * Parse Claude's JSON response into typed ScoredSegment array.
 * Handles markdown fences, stray text, etc.
 */
function parseSegments(text: string): ScoredSegment[] {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) throw new Error('No JSON array in Claude response');

  const parsed = JSON.parse(arrayMatch[0]) as unknown[];

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      start: Number(item.start) || 0,
      end: Number(item.end) || 0,
      waffle_confidence: Math.min(100, Math.max(0, Number(item.waffle_confidence) || 0)),
      category: String(item.category || 'substance'),
      label: String(item.label || ''),
    }));
}

/**
 * Merge adjacent segments with the same category and close confidence scores.
 * Keeps the segment list compact without losing resolution.
 */
function mergeAdjacentSegments(segments: ScoredSegment[]): ScoredSegment[] {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: ScoredSegment[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const prev = merged[merged.length - 1];
    const gap = curr.start - prev.end;
    const sameCat = curr.category === prev.category;
    const closeConf = Math.abs(curr.waffle_confidence - prev.waffle_confidence) <= 15;

    if (sameCat && closeConf && gap <= 2) {
      // Merge: extend end, average confidence, keep longer label
      prev.end = Math.max(prev.end, curr.end);
      prev.waffle_confidence = Math.round(
        (prev.waffle_confidence + curr.waffle_confidence) / 2
      );
      if (curr.label.length > prev.label.length) {
        prev.label = curr.label;
      }
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
