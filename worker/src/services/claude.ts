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
//
// v2.0 — Topic-anchored scoring. Identifies the video topic first, then
//         scores each segment against it. Adds category granularity
//         (pleasantries, cohost_echo, context), explicit podcast/interview
//         rules for co-host filler, and an assertive calibration nudge.
const SYSTEM_PROMPT = `You analyse YouTube video transcripts to detect filler content ("waffle") that wastes the viewer's time.

STEP 1: Read the full transcript. Identify the VIDEO TOPIC — what is this video actually about? State it in one sentence. This is your anchor for all classification: keep things the video IS ABOUT, cut everything else.

STEP 2: For each segment, assign a waffle_confidence score (0-100) based on how relevant it is to the VIDEO TOPIC:

95-100 DEFINITE WAFFLE — zero relation to the video topic:
- Sponsor reads, ad segments, paid promotions
- "Like and subscribe", "hit the bell", "leave a comment below"
- Patreon, merch, social media plugs
- Channel branding intros/outros with no content

80-94 STRONG WAFFLE — not about the topic:
- Generic pleasantries: "hope you're having a great day", weather chat, "how's everyone doing"
- Personal life updates unrelated to the topic: what they ate, their commute, weekend plans
- "Before we get into it..." padding that doesn't actually get into it
- Repetition of something already said (same point, rephrased)
- Thanking other creators, shoutouts unrelated to content
- Co-host/sidekick reactions that add no substance: "yeah totally", "that's crazy", "wow", "right right right"
- Co-host echoing or rephrasing what the main speaker just said without adding new information ("So basically what you're saying is..." then repeating the same point)

60-79 PROBABLE WAFFLE — loosely related tangent:
- Personal anecdotes that are entertaining but don't advance the topic
- Extended examples that repeat a point already made
- Off-topic digressions that eventually circle back
- Overly long context-setting that could have been shorter

40-59 BORDERLINE — debatable relevance:
- Background context some viewers might want
- Stories that illustrate the point but take longer than necessary
- Introductions of people/concepts needed later but done slowly

20-39 MOSTLY SUBSTANCE — relevant with minor padding:
- On-topic but slightly verbose
- Good content with some filler words or hedging

0-19 PURE SUBSTANCE — core content:
- Direct teaching, arguments, insights, facts about the topic
- Key stories that ARE the content (not illustrations of it)
- Essential context without which the topic makes no sense
- Conclusions, summaries, actionable takeaways

STEP 3: Also classify each segment's category. Use exactly one of:
- "sponsor" — paid promotion or ad read
- "self_promo" — subscribe, bell, merch, patreon, social plugs
- "pleasantries" — greetings, weather, "hope you're well", generic chat
- "tangent" — off-topic story or digression
- "repetition" — restating something already covered
- "cohost_echo" — co-host repeating, echoing, or reacting without adding substance
- "filler" — ums, dead air, "so yeah", padding
- "intro_outro" — channel branding, opening/closing sequences
- "context" — background info, setup for the main topic
- "substance" — core content about the video topic

PODCAST/INTERVIEW RULES:
- In multi-speaker videos, identify the PRIMARY speaker (the guest, expert, or person with the interesting story). Their on-topic content is almost always substance.
- Co-hosts, interviewers, and sidekicks who merely react ("wow", "that's insane", "right right right"), echo what was just said, or rephrase the primary speaker's points without adding NEW information should be classified as cohost_echo (confidence 80-90).
- Co-hosts who ask genuinely new questions, challenge a point, or introduce new information ARE substance.
- The test: if you removed the co-host's segment, would the viewer miss any information? If no, it's waffle.

Respond ONLY with valid JSON. No other text, no markdown fences, no explanation.

First line: {"video_topic": "one sentence description of what this video is about"}
Then a JSON array of segments:
[{"start": 0, "end": 30, "waffle_confidence": 85, "category": "pleasantries", "label": "Host greets viewers and talks about the weather"}, ...]

RULES:
- Every second of the transcript must be covered — no gaps between segments.
- Merge adjacent segments with the same classification (within 10 points of confidence).
- Short segments (under 10 seconds) should be merged with their neighbours.
- Be AGGRESSIVE about detecting waffle — viewers came for the topic, not the padding.
- A 10-minute video typically has 2-4 minutes of waffle. If you're finding zero waffle, you're being too lenient.
- Use the video title (provided in the user message) as a strong signal for what the video is about.`;

// Model fallback candidates — try each in order until one works
const MODEL_CANDIDATES = [
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-latest',
  'claude-3-5-haiku-latest',
];

/**
 * Send transcript chunks to Claude and get back confidence-scored segments.
 * Handles model fallback and response parsing.
 *
 * @param videoTitle — optional YouTube video title, passed to Claude as a
 *   strong signal for what the video is about (topic anchor).
 */
export async function classifyTranscript(
  chunks: TranscriptChunk[],
  env: Env,
  videoTitle?: string
): Promise<ScoredSegment[]> {
  const BATCH_SIZE = 40;
  const allSegments: ScoredSegment[] = [];

  // Process in batches of 40 chunks to stay within context limits
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchResult = await classifyBatch(batch, env, videoTitle);
    allSegments.push(...batchResult);
  }

  // Merge adjacent segments with same category and similar confidence
  return mergeAdjacentSegments(allSegments);
}

async function classifyBatch(
  chunks: TranscriptChunk[],
  env: Env,
  videoTitle?: string
): Promise<ScoredSegment[]> {
  // Build the user message — include video title as topic anchor when available
  const chunkText = chunks
    .map(
      (c, i) =>
        `[${fmtTime(c.start)} - ${fmtTime(c.end)}] ${c.text}`
    )
    .join('\n\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n\n` : '';
  const userMessage = `${titleLine}Transcript:\n${chunkText}`;

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
 * Handles the v2 response format:
 *   {"video_topic": "..."}
 *   [{"start": 0, "end": 30, ...}, ...]
 * Also handles markdown fences, stray text, single JSON array, etc.
 */
function parseSegments(text: string): ScoredSegment[] {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  // Extract the JSON array (skip the video_topic line if present)
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
