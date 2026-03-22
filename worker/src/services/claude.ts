// claude.ts — Claude API client for woffle classification.
// Two-pass architecture:
//   Pass 1 (Quick): Haiku analyses first 90s for intro detection (~1-2s)
//   Pass 2 (Full):  Sonnet analyses full transcript with streaming (~10-15s)
//
// PROMPT_VERSION in wrangler.toml must be bumped whenever the prompt changes
// so stale cache entries are bypassed and re-analysed.

import type { Env } from '../index';

export interface TranscriptChunk {
  start: number;
  end: number;
  text: string;
}

export interface ScoredSegment {
  start: number;
  end: number;
  woffle_confidence: number;
  category: string;
  label: string;
}

export interface QuickIntroResult {
  intro_ends_at: number;
  intro_type: string;
  topic_starts: string;
}

// ============================================================
// Models
// ============================================================

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-5-20250929';

// ============================================================
// Quick Intro Scan Prompt (Haiku)
// ============================================================

const QUICK_INTRO_PROMPT = `You detect where a YouTube video's actual content begins.
The intro typically contains: greetings, pleasantries, weather chat,
"hope you're doing well", sponsor reads, "before we get into it" padding,
channel branding, subscribe requests.

Given the first 90 seconds of transcript, find where the REAL CONTENT
starts — the first moment the speaker discusses the actual video topic.

Respond with ONLY this JSON (no other text):
{"intro_ends_at": <seconds>, "intro_type": "pleasantries|sponsor|branding|none", "topic_starts": "brief description of what the real content is about"}

If the video jumps straight into content with no intro padding,
respond: {"intro_ends_at": 0, "intro_type": "none", "topic_starts": "..."}`;

// ============================================================
// Full Classification Prompt (Sonnet)
// ============================================================
// v3.0 — Single-pass full-transcript analysis with natural segmentation.
//         Sonnet 4.5 for nuanced relevance judgement. Aggressive woffle
//         detection with co-host/podcast rules.

const FULL_SYSTEM_PROMPT = `You analyse YouTube video transcripts to detect filler content ("woffle") — anything that wastes the viewer's time.

STEP 1: Read the video title and full transcript. Identify the VIDEO TOPIC in one sentence. This is your anchor — everything is judged against it.

STEP 2: Create natural segments based on content shifts (NOT fixed time intervals). Each segment should be one coherent block: a greeting, an anecdote, a teaching section, a sponsor read, etc. Segments can be 10 seconds to several minutes.

STEP 3: Score each segment's woffle_confidence (0-100):

95-100 DEFINITE WOFFLE:
- Sponsor reads, ad segments, paid promotions
- "Like and subscribe", "hit the bell", "leave a comment below"
- Patreon, merch, social media plugs
- Channel branding intros/outros with zero content

85-94 STRONG WOFFLE:
- Generic pleasantries: "hope you're having a great day", weather chat, "how's everyone doing"
- Personal life updates unrelated to topic: what they ate, their commute, weekend plans
- "Before we get into it..." padding that doesn't get into anything
- Repetition of something already covered (same point rephrased)
- Thanking other creators, shoutouts unrelated to content
- Co-host reactions that add nothing: "wow", "that's crazy", "yeah totally", "right right right"
- Co-host echoing/rephrasing what the main speaker just said without new information
- Co-host tangents and musings that nobody came to hear

70-84 PROBABLE WOFFLE:
- Personal anecdotes entertaining but not advancing the topic
- Extended examples repeating a point already made
- Off-topic digressions that eventually circle back
- Overly long context-setting that could be 80% shorter

50-69 BORDERLINE:
- Background context some viewers want, others don't
- Stories illustrating the point but taking too long
- Slow introductions of people/concepts needed later

25-49 MOSTLY SUBSTANCE:
- On-topic but slightly verbose or meandering
- Good content with minor padding

0-24 PURE SUBSTANCE:
- Core content directly about the video topic
- Key stories that ARE the content
- Essential context, conclusions, actionable takeaways
- Questions from interviewer/co-host that genuinely advance the conversation

PODCAST/INTERVIEW RULES:
- Identify the PRIMARY speaker (guest, expert, storyteller). Their on-topic content is almost always substance.
- Co-hosts/interviewers who merely react, echo, or rephrase = woffle (85-90).
- Co-hosts who ask NEW questions or introduce NEW information = substance.
- Test: if you removed this segment, would the viewer miss any information? If no → woffle.

CRITICAL RULES:
- Be AGGRESSIVE about detecting woffle. Viewers came for the topic, not padding.
- A typical 10-minute video has 2-4 minutes of woffle. If you find zero, you're too lenient.
- Every second of the video must be covered — no gaps between segments.
- Merge adjacent segments with similar scores (within 10 points).
- Create your own segment boundaries based on natural content shifts — do NOT use fixed-length segments. A segment should be one coherent block of content: a complete anecdote, a sponsor read, a greeting sequence, a teaching section, etc. Segments can range from 10 seconds to several minutes depending on content.

Classify each segment's category (exactly one):
- "sponsor" — paid promotion or ad read
- "self_promo" — subscribe, bell, merch, patreon, social plugs
- "pleasantries" — greetings, weather, hope you're well, generic chat
- "tangent" — off-topic story or digression
- "repetition" — restating something already covered
- "cohost_echo" — co-host repeating, reacting, or echoing without substance
- "filler" — ums, dead air, "so yeah", padding words
- "intro_outro" — channel branding, opening/closing sequences with no content
- "context" — background info, setup for the main topic
- "substance" — core content about the video topic

Respond ONLY with valid JSON. No markdown, no explanation, no preamble.

Format:
{"video_topic": "one sentence about what this video covers", "segments": [{"start": 0, "end": 45, "woffle_confidence": 92, "category": "pleasantries", "label": "Host greets viewers and chats about the weather"}, ...]}`;

// ============================================================
// Quick Intro Scan (Haiku — 1-2 seconds)
// ============================================================
// Detects where the intro ends so we can skip it immediately
// while the full Sonnet analysis streams in the background.
// No credit cost, not cached.

export async function classifyIntroQuick(
  chunks: TranscriptChunk[],
  env: Env,
  videoTitle?: string
): Promise<QuickIntroResult> {
  // Only send first 90 seconds of transcript
  const first90s = chunks.filter(c => c.start < 90);
  if (first90s.length === 0) {
    return { intro_ends_at: 0, intro_type: 'none', topic_starts: '' };
  }

  const chunkText = first90s
    .map(c => `[${fmtTime(c.start)}] ${c.text}`)
    .join('\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n\n` : '';
  const userMessage = `${titleLine}First 90 seconds of transcript:\n${chunkText}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 256,
      system: QUICK_INTRO_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Quick scan failed: ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const text = (data.content || [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text!)
    .join('')
    .trim();

  if (!text) {
    return { intro_ends_at: 0, intro_type: 'none', topic_starts: '' };
  }

  try {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      intro_ends_at: Number(parsed.intro_ends_at) || 0,
      intro_type: String(parsed.intro_type || 'none'),
      topic_starts: String(parsed.topic_starts || ''),
    };
  } catch {
    return { intro_ends_at: 0, intro_type: 'none', topic_starts: '' };
  }
}

// ============================================================
// Full Classification with Streaming (Sonnet — 10-15 seconds)
// ============================================================
// Sends the ENTIRE transcript in one call to Sonnet 4.5 with stream: true.
// Returns a ReadableStream of SSE events that the worker route pipes
// directly to the client. Segments are emitted incrementally as they're
// parsed from the streaming response.
//
// SSE event types:
//   event: topic    — {"video_topic": "..."}
//   event: segment  — {"start": N, "end": N, "woffle_confidence": N, ...}
//   event: done     — {"total_segments": N}
//   event: error    — {"error": "message"}

export function classifyFullTranscriptStreaming(
  chunks: TranscriptChunk[],
  env: Env,
  videoTitle?: string,
  videoDurationSeconds?: number
): { stream: ReadableStream; segmentsPromise: Promise<ScoredSegment[]> } {
  // Build the full transcript as a single timestamped block.
  // Sonnet sees the whole video context, enabling much better topic-anchored
  // classification than the old chunk-by-chunk approach.
  const chunkText = chunks
    .map(c => `[${fmtTime(c.start)}] ${c.text}`)
    .join('\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n` : '';
  const durationLine = videoDurationSeconds
    ? `Video duration: ${Math.round(videoDurationSeconds / 60)} minutes\n`
    : '';
  const userMessage = `${titleLine}${durationLine}\nFull transcript:\n${chunkText}`;

  // Accumulate all segments for caching after stream completes
  const allSegments: ScoredSegment[] = [];
  let resolveSegments: (segments: ScoredSegment[]) => void;
  let rejectSegments: (err: Error) => void;
  const segmentsPromise = new Promise<ScoredSegment[]>((resolve, reject) => {
    resolveSegments = resolve;
    rejectSegments = reject;
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Process the Anthropic stream in the background
  (async () => {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: 4096,
          stream: true,
          system: FULL_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        const errorMsg = `API ${response.status}: ${errText}`;
        await writer.write(encoder.encode(
          `event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`
        ));
        await writer.close();
        rejectSegments!(new Error(errorMsg));
        return;
      }

      // Read the Anthropic SSE stream and extract text deltas.
      // Claude's streaming format sends content_block_delta events
      // with delta.text containing the next chunk of generated text.
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let fullText = '';
      let emittedSegments = 0;
      let topicEmitted = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines from the Anthropic stream
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              fullText += event.delta.text;

              // Try to parse segments incrementally from accumulated text
              const parseResult = parseIncremental(fullText, emittedSegments, topicEmitted);

              // Emit topic as soon as we find it
              if (parseResult.topic && !topicEmitted) {
                topicEmitted = true;
                await writer.write(encoder.encode(
                  `event: topic\ndata: ${JSON.stringify({ video_topic: parseResult.topic })}\n\n`
                ));
              }

              // Emit any newly parsed segments
              for (let i = emittedSegments; i < parseResult.segments.length; i++) {
                const seg = parseResult.segments[i];
                allSegments.push(seg);
                await writer.write(encoder.encode(
                  `event: segment\ndata: ${JSON.stringify(seg)}\n\n`
                ));
                emittedSegments++;
              }
            }
          } catch {
            // Skip malformed JSON lines — normal during streaming
          }
        }
      }

      // Final parse to catch any remaining segments the incremental parser missed
      const finalResult = parseFinal(fullText);
      for (let i = emittedSegments; i < finalResult.segments.length; i++) {
        const seg = finalResult.segments[i];
        allSegments.push(seg);
        await writer.write(encoder.encode(
          `event: segment\ndata: ${JSON.stringify(seg)}\n\n`
        ));
      }

      if (!topicEmitted && finalResult.topic) {
        await writer.write(encoder.encode(
          `event: topic\ndata: ${JSON.stringify({ video_topic: finalResult.topic })}\n\n`
        ));
      }

      // Merge adjacent segments before caching — the final merged set is what
      // gets stored in the shared cache for all users.
      const merged = mergeAdjacentSegments(
        finalResult.segments.length > allSegments.length
          ? finalResult.segments
          : allSegments
      );

      await writer.write(encoder.encode(
        `event: done\ndata: ${JSON.stringify({ total_segments: merged.length })}\n\n`
      ));
      await writer.close();

      resolveSegments!(merged);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await writer.write(encoder.encode(
          `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`
        ));
        await writer.close();
      } catch {
        // Writer already closed
      }
      rejectSegments!(err instanceof Error ? err : new Error(message));
    }
  })();

  return { stream: readable, segmentsPromise };
}

// ============================================================
// Non-streaming fallback
// ============================================================
// Used when streaming fails or for backwards compatibility.
// Sends full transcript to Sonnet and waits for the complete response.

export async function classifyFullTranscript(
  chunks: TranscriptChunk[],
  env: Env,
  videoTitle?: string,
  videoDurationSeconds?: number
): Promise<ScoredSegment[]> {
  const chunkText = chunks
    .map(c => `[${fmtTime(c.start)}] ${c.text}`)
    .join('\n');

  const titleLine = videoTitle ? `Video title: "${videoTitle}"\n` : '';
  const durationLine = videoDurationSeconds
    ? `Video duration: ${Math.round(videoDurationSeconds / 60)} minutes\n`
    : '';
  const userMessage = `${titleLine}${durationLine}\nFull transcript:\n${chunkText}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 4096,
      system: FULL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const text = (data.content || [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text!)
    .join('\n')
    .trim();

  if (!text) throw new Error('Empty Claude response');

  const result = parseFinal(text);
  return mergeAdjacentSegments(result.segments);
}

// ============================================================
// Incremental JSON Parser
// ============================================================
// Extracts segments from partially complete Claude output.
// Tracks brace depth to detect complete {...} objects within
// the segments array as they stream in.

function parseIncremental(
  text: string,
  alreadyParsed: number,
  topicParsed: boolean
): { topic: string | null; segments: ScoredSegment[] } {
  let topic: string | null = null;
  const segments: ScoredSegment[] = [];

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  // Extract video_topic
  if (!topicParsed) {
    const topicMatch = cleaned.match(/"video_topic"\s*:\s*"([^"]+)"/);
    if (topicMatch) topic = topicMatch[1];
  }

  // Find the segments array
  const segArrayMatch = cleaned.match(/"segments"\s*:\s*\[/);
  if (!segArrayMatch) return { topic, segments };

  const arrayStart = cleaned.indexOf('[', segArrayMatch.index!);
  if (arrayStart === -1) return { topic, segments };

  // Extract complete segment objects by tracking brace depth
  let depth = 0;
  let objStart = -1;

  for (let i = arrayStart + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];

    // Skip string contents to avoid counting braces inside strings
    if (ch === '"') {
      i++;
      while (i < cleaned.length && cleaned[i] !== '"') {
        if (cleaned[i] === '\\') i++;
        i++;
      }
      continue;
    }

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objStr = cleaned.substring(objStart, i + 1);
        try {
          const obj = JSON.parse(objStr);
          segments.push({
            start: Number(obj.start) || 0,
            end: Number(obj.end) || 0,
            woffle_confidence: Math.min(100, Math.max(0, Number(obj.woffle_confidence) || 0)),
            category: String(obj.category || 'substance'),
            label: String(obj.label || ''),
          });
        } catch {
          // Incomplete or malformed — skip
        }
        objStart = -1;
      }
    }
  }

  return { topic, segments };
}

// ============================================================
// Final JSON Parser
// ============================================================
// Extracts all segments from the complete response. More robust
// than incremental since we have the full text.

function parseFinal(text: string): { topic: string; segments: ScoredSegment[] } {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let topic = '';

  // Try to parse as a single JSON object first (ideal case)
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.video_topic) topic = parsed.video_topic;
    if (Array.isArray(parsed.segments)) {
      return {
        topic,
        segments: parsed.segments.map((item: Record<string, unknown>) => ({
          start: Number(item.start) || 0,
          end: Number(item.end) || 0,
          woffle_confidence: Math.min(100, Math.max(0, Number(item.woffle_confidence) || 0)),
          category: String(item.category || 'substance'),
          label: String(item.label || ''),
        })),
      };
    }
  } catch {
    // Fall through to regex extraction
  }

  // Extract topic via regex
  const topicMatch = cleaned.match(/"video_topic"\s*:\s*"([^"]+)"/);
  if (topicMatch) topic = topicMatch[1];

  // Extract segments array via regex
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return { topic, segments: [] };

  try {
    const parsed = JSON.parse(arrayMatch[0]) as unknown[];
    return {
      topic,
      segments: parsed
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map(item => ({
          start: Number(item.start) || 0,
          end: Number(item.end) || 0,
          woffle_confidence: Math.min(100, Math.max(0, Number(item.woffle_confidence) || 0)),
          category: String(item.category || 'substance'),
          label: String(item.label || ''),
        })),
    };
  } catch {
    return { topic, segments: [] };
  }
}

// ============================================================
// Segment Merging
// ============================================================
// Merge adjacent segments with the same category and close confidence
// scores. Keeps the segment list compact without losing resolution.

export function mergeAdjacentSegments(segments: ScoredSegment[]): ScoredSegment[] {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: ScoredSegment[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const prev = merged[merged.length - 1];
    const gap = curr.start - prev.end;
    const sameCat = curr.category === prev.category;
    const closeConf = Math.abs(curr.woffle_confidence - prev.woffle_confidence) <= 15;

    if (sameCat && closeConf && gap <= 2) {
      // Merge: extend end, average confidence, keep longer label
      prev.end = Math.max(prev.end, curr.end);
      prev.woffle_confidence = Math.round(
        (prev.woffle_confidence + curr.woffle_confidence) / 2
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

// ============================================================
// Utility
// ============================================================

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
