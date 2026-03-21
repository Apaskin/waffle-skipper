// analyse.ts — POST /api/analyse and GET /api/analyse/:video_id
// Two-pass classification:
//   mode: 'quick' — Haiku intro scan, returns JSON, no credit cost, not cached
//   mode: 'full'  — Sonnet full analysis with SSE streaming, 1 credit, cached

import type { Env } from '../index';
import { verifyAuth, AuthError } from '../middleware/auth';
import { checkCredits, deductCredit } from '../services/credits';
import { getCachedAnalysis, incrementAccessCount, cacheAnalysis } from '../services/cache';
import {
  classifyIntroQuick,
  classifyFullTranscriptStreaming,
  classifyFullTranscript,
  type TranscriptChunk,
} from '../services/claude';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/analyse
 * Body: { mode, video_id, transcript_chunks, video_title?, video_duration_seconds? }
 *
 * mode: 'quick' — Haiku scans first 90s for intro detection. Free, fast, not cached.
 * mode: 'full'  — Sonnet analyses full transcript with streaming SSE response.
 *                  Costs 1 credit, result cached in Supabase after stream completes.
 */
export async function handleAnalyse(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  // 1. Auth
  let userId: string;
  try {
    userId = await verifyAuth(request, env);
  } catch (err) {
    if (err instanceof AuthError) return json({ error: 'unauthorized' }, err.status);
    throw err;
  }

  // Parse body
  let body: {
    mode?: 'quick' | 'full';
    video_id?: string;
    transcript_chunks?: TranscriptChunk[];
    video_title?: string;
    video_duration_seconds?: number;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const { mode = 'full', video_id, transcript_chunks, video_title, video_duration_seconds } = body;

  if (!video_id || typeof video_id !== 'string') {
    return json({ error: 'missing_video_id' }, 400);
  }
  if (!transcript_chunks || !Array.isArray(transcript_chunks) || transcript_chunks.length === 0) {
    return json({ error: 'missing_transcript_chunks' }, 400);
  }

  // ============================================================
  // Quick mode — Haiku intro scan (no credit, no cache)
  // ============================================================
  if (mode === 'quick') {
    try {
      const result = await classifyIntroQuick(transcript_chunks, env, video_title);
      return json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Woffle] Quick scan failed:', message);
      return json({ error: 'quick_scan_failed', detail: message }, 502);
    }
  }

  // ============================================================
  // Full mode — Sonnet streaming analysis
  // ============================================================

  // 2. Check shared cache
  const cached = await getCachedAnalysis(video_id, env);
  if (cached) {
    // Cache hit — serve from cache, no credit cost
    incrementAccessCount(cached.id, env).catch(() => {});
    return json({
      segments: cached.segments,
      from_cache: true,
      prompt_version: cached.prompt_version,
    });
  }

  // 3. Check credits
  try {
    await checkCredits(userId, env);
  } catch (err: unknown) {
    const code = (err as Error & { code?: string })?.code;
    if (code === 'no_credits') {
      return json({ error: 'no_credits', credits_remaining: 0 }, 402);
    }
    throw err;
  }

  // 4. Stream the classification response
  try {
    const { stream, segmentsPromise } = classifyFullTranscriptStreaming(
      transcript_chunks, env, video_title, video_duration_seconds
    );

    // After the stream completes, cache the result and deduct credit.
    // Use waitUntil if available (Cloudflare Workers) to keep the worker alive
    // after the response body finishes streaming.
    const afterStream = segmentsPromise.then(async (segments) => {
      // Cache the merged segments for all users
      await cacheAnalysis(
        video_id, segments, 'claude-sonnet-4-5-20250514',
        userId, env, video_title, video_duration_seconds
      ).catch((err) => console.error('[Woffle] Cache write failed:', err));

      // Deduct 1 credit
      await deductCredit(userId, video_id, env)
        .catch((err) => console.error('[Woffle] Credit deduction failed:', err));
    }).catch((err) => {
      console.error('[Woffle] Post-stream processing failed:', err);
    });

    // Keep worker alive for cache write + credit deduction
    if (ctx?.waitUntil) {
      ctx.waitUntil(afterStream);
    }

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    // Streaming setup failed — fall back to non-streaming
    console.error('[Woffle] Streaming failed, falling back:', err);

    try {
      const segments = await classifyFullTranscript(
        transcript_chunks, env, video_title, video_duration_seconds
      );

      // Cache and deduct (fire-and-forget)
      cacheAnalysis(video_id, segments, 'claude-sonnet-4-5-20250514', userId, env, video_title, video_duration_seconds)
        .catch((err) => console.error('[Woffle] Cache write failed:', err));
      deductCredit(userId, video_id, env)
        .catch((err) => console.error('[Woffle] Credit deduction failed:', err));

      return json({
        segments,
        from_cache: false,
        prompt_version: env.PROMPT_VERSION,
      });
    } catch (fallbackErr) {
      const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.error('[Woffle] Classification failed:', message);
      return json({ error: 'classification_failed', detail: message }, 502);
    }
  }
}

/**
 * GET /api/analyse/:video_id
 * Pre-check: returns cached analysis if it exists, null if not.
 * Used by the extension to check the shared cache before sending the full transcript.
 */
export async function handleGetAnalysis(
  request: Request,
  env: Env,
  videoId: string
): Promise<Response> {
  // Auth required even for cache reads (we need to know the user is legit)
  try {
    await verifyAuth(request, env);
  } catch (err) {
    if (err instanceof AuthError) return json({ error: 'unauthorized' }, err.status);
    throw err;
  }

  if (!videoId) {
    return json({ error: 'missing_video_id' }, 400);
  }

  const cached = await getCachedAnalysis(videoId, env);
  if (cached) {
    incrementAccessCount(cached.id, env).catch(() => {});
    return json({
      segments: cached.segments,
      from_cache: true,
      prompt_version: cached.prompt_version,
    });
  }

  return json({ segments: null, from_cache: false });
}
