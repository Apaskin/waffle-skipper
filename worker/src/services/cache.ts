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
  const params = new URLSearchParams({
    video_id: `eq.${videoId}`,
    prompt_version: `eq.${env.PROMPT_VERSION}`,
    select: '*',
  });

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/analyses?${params.toString()}`,
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
 * Atomically increment the access_count on a cached analysis.
 * Uses the increment_access_count RPC to avoid read-then-write races.
 * Fire-and-forget — errors here are non-critical.
 */
export async function incrementAccessCount(
  analysisId: string,
  env: Env
): Promise<void> {
  try {
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/increment_access_count`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({ p_analysis_id: analysisId }),
      }
    );
  } catch {
    // Non-critical — swallow errors
  }
}

/**
 * Store a new analysis in the shared cache.
 * Uses Supabase's ON CONFLICT resolution header to handle the race where
 * two users analyse the same video+prompt_version simultaneously — the
 * second insert silently becomes a no-op.
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
      Prefer: 'return=minimal,resolution=ignore-duplicates',
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
