// channels.ts — POST /api/channels
// Manages auto-analyse channel list for Plus/Pro users.
// Free tier is rejected. Plus is capped at 5. Pro is unlimited.

import type { Env } from '../index';
import { verifyAuth, AuthError } from '../middleware/auth';
import { getUser } from '../services/credits';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Max channel IDs per tier
const CHANNEL_LIMITS: Record<string, number> = {
  free: 0,
  plus: 5,
  pro: Infinity,
};

/**
 * POST /api/channels
 * Body: { channel_ids: ['UCxxx', ...] }
 * Validates tier allows channel auto-analyse, enforces per-tier limits.
 */
export async function handleChannels(request: Request, env: Env): Promise<Response> {
  let userId: string;
  try {
    userId = await verifyAuth(request, env);
  } catch (err) {
    if (err instanceof AuthError) return json({ error: 'unauthorized' }, err.status);
    throw err;
  }

  // Parse body
  let body: { channel_ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const { channel_ids } = body;
  if (!Array.isArray(channel_ids)) {
    return json({ error: 'channel_ids must be an array' }, 400);
  }

  // Sanitise: only keep non-empty strings, dedupe
  const cleaned = [...new Set(channel_ids.filter((id) => typeof id === 'string' && id.trim()))];

  // Check tier
  const user = await getUser(userId, env);
  const limit = CHANNEL_LIMITS[user.tier] ?? 0;

  if (limit === 0) {
    return json({ error: 'upgrade_required', message: 'Channel auto-analyse requires Plus or Pro' }, 403);
  }

  if (cleaned.length > limit) {
    return json({
      error: 'channel_limit_exceeded',
      message: `Your ${user.tier} tier allows up to ${limit} channels`,
      limit,
    }, 400);
  }

  // Update user record
  const patchRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ auto_analyse_channels: cleaned }),
    }
  );

  if (!patchRes.ok) {
    return json({ error: 'failed_to_update_channels' }, 500);
  }

  return json({ auto_analyse_channels: cleaned });
}
