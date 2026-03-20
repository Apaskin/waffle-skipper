// auth.ts — GET /api/me
// Returns the authenticated user's profile: tier, credits, channels, etc.

import type { Env } from '../index';
import { verifyAuth, AuthError } from '../middleware/auth';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface UserProfile {
  id: string;
  email: string;
  tier: string;
  credits_remaining: number;
  credits_monthly_limit: number;
  credits_reset_at: string;
  auto_analyse_channels: string[];
}

/**
 * GET /api/me
 * Returns the authenticated user's tier, credits, and channel settings.
 * Called by the extension on load to hydrate the popup UI.
 */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  let userId: string;
  try {
    userId = await verifyAuth(request, env);
  } catch (err) {
    if (err instanceof AuthError) return json({ error: 'unauthorized' }, err.status);
    throw err;
  }

  // Fetch user record via service role
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=id,email,tier,credits_remaining,credits_monthly_limit,credits_reset_at,auto_analyse_channels`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    return json({ error: 'failed_to_fetch_user' }, 500);
  }

  const rows = (await res.json()) as UserProfile[];
  if (rows.length === 0) {
    return json({ error: 'user_not_found' }, 404);
  }

  const user = rows[0];
  return json({
    tier: user.tier,
    credits_remaining: user.credits_remaining,
    credits_monthly_limit: user.credits_monthly_limit,
    credits_reset_at: user.credits_reset_at,
    auto_analyse_channels: user.auto_analyse_channels || [],
  });
}
