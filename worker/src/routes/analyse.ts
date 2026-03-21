// analyse.ts — POST /api/analyse and GET /api/analyse/:video_id
// The core route: checks shared cache, deducts credits, calls Claude,
// stores results in the shared cache for all users.

import type { Env } from '../index';
import { verifyAuth, AuthError } from '../middleware/auth';
import { checkCredits, deductCredit } from '../services/credits';
import { getCachedAnalysis, incrementAccessCount, cacheAnalysis } from '../services/cache';
import { classifyTranscript, type TranscriptChunk } from '../services/claude';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/analyse
 * Body: { video_id, transcript_chunks: [{start, end, text}], video_title?, video_duration_seconds? }
 *
 * Flow:
 * 1. Verify JWT → get user_id
 * 2. Check shared cache for existing analysis with current prompt_version
 * 3. Cache hit → increment access_count, return segments (no credit deducted)
 * 4. Cache miss → check user has credits
 * 5. Call Claude Haiku with confidence-scoring prompt
 * 6. Store in shared cache
 * 7. Deduct 1 credit, log transaction
 * 8. Return segments
 */
export async function handleAnalyse(request: Request, env: Env): Promise<Response> {
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

  const { video_id, transcript_chunks, video_title, video_duration_seconds } = body;

  if (!video_id || typeof video_id !== 'string') {
    return json({ error: 'missing_video_id' }, 400);
  }
  if (!transcript_chunks || !Array.isArray(transcript_chunks) || transcript_chunks.length === 0) {
    return json({ error: 'missing_transcript_chunks' }, 400);
  }

  // 2. Check shared cache
  const cached = await getCachedAnalysis(video_id, env);
  if (cached) {
    // 3. Cache hit — serve from cache, no credit cost
    // Fire-and-forget: increment the access counter
    incrementAccessCount(cached.id, env).catch(() => {});
    return json({
      segments: cached.segments,
      from_cache: true,
      prompt_version: cached.prompt_version,
    });
  }

  // 4. Check credits
  try {
    await checkCredits(userId, env);
  } catch (err: unknown) {
    const code = (err as Error & { code?: string })?.code;
    if (code === 'no_credits') {
      return json({ error: 'no_credits', credits_remaining: 0 }, 402);
    }
    throw err;
  }

  // 5. Call Claude
  let segments;
  try {
    segments = await classifyTranscript(transcript_chunks, env, video_title);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Woffle] Classification failed:', message);
    return json({ error: 'classification_failed', detail: message }, 502);
  }

  // 6. Store in shared cache (fire-and-forget — don't block the response)
  cacheAnalysis(video_id, segments, null, userId, env, video_title, video_duration_seconds)
    .catch((err) => console.error('[Woffle] Cache write failed:', err));

  // 7. Deduct credit
  try {
    await deductCredit(userId, video_id, env);
  } catch (err) {
    // Credit deduction failed — log but still return the result.
    // The user already got the analysis; we'll reconcile later.
    console.error('[Woffle] Credit deduction failed:', err);
  }

  // 8. Return
  return json({
    segments,
    from_cache: false,
    prompt_version: env.PROMPT_VERSION,
  });
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
