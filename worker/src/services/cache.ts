// cache.ts — Shared analysis cache read/write.
// Reads are available to all authenticated users (via RLS).
// Writes use the service role (bypasses RLS).

import type { Env } from '../index';
import type { ScoredSegment } from './claude';

export interface CachedAnalysis {
  id: string;
  video_id: string;
  video_title: string | null;
  video_duration_seconds: number | null;
  segments: ScoredSegment[];
  model_used: string | null;
  prompt_version: string;
  created_at: string;
  access_count: number;
}

/**
 * Look up a cached analysis by video_id AND current prompt_version.
 * Returns null on cache miss (or if the cached entry is from an older prompt version).
 */
export async function getCachedAnalysis(
  videoId: string,
  env: Env
): Promise<CachedAnalysis | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/analyses?video_id=eq.${encodeURIComponent(videoId)}&prompt_version=eq.${encodeURIComponent(env.PROMPT_VERSION)}&select=*`,
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!res.ok) return null;

  const rows = (await res.json()) as CachedAnalysis[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Increment the access_count on a cached analysis (tracks popularity).
 * Fire-and-forget — errors here are non-critical.
 */
export async function incrementAccessCount(
  analysisId: string,
  env: Env
): Promise<void> {
  // Supabase REST doesn't support atomic increment natively,
  // so we read + write. Acceptable for a counter — exact accuracy isn't critical.
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/analyses?id=eq.${analysisId}&select=access_count`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ access_count: number }>;
    if (rows.length === 0) return;

    await fetch(
      `${env.SUPABASE_URL}/rest/v1/analyses?id=eq.${analysisId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ access_count: rows[0].access_count + 1 }),
      }
    );
  } catch {
    // Non-critical — swallow errors
  }
}

/**
 * Store a new analysis in the shared cache.
 */
export async function cacheAnalysis(
  videoId: string,
  segments: ScoredSegment[],
  modelUsed: string | null,
  requestedBy: string,
  env: Env,
  videoTitle?: string,
  videoDurationSeconds?: number
): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/analyses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=minimal',
      // On conflict (duplicate video_id) — don't error, just skip.
      // This handles the race where two users analyse the same video simultaneously.
      'on-conflict': 'video_id',
    },
    body: JSON.stringify({
      video_id: videoId,
      video_title: videoTitle || null,
      video_duration_seconds: videoDurationSeconds || null,
      segments,
      model_used: modelUsed,
      prompt_version: env.PROMPT_VERSION,
      requested_by: requestedBy,
      access_count: 1,
    }),
  });
}
