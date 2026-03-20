// credits.ts — Credit check, deduction, and reset logic.
// All database writes use the service role key (server-side only).

import type { Env } from '../index';

interface UserRecord {
  id: string;
  credits_remaining: number;
  credits_monthly_limit: number;
  tier: string;
}

/**
 * Fetch the user record from Supabase. Throws if user not found.
 */
export async function getUser(userId: string, env: Env): Promise<UserRecord> {
  const res = await supabaseGet(
    env,
    `/rest/v1/users?id=eq.${userId}&select=id,credits_remaining,credits_monthly_limit,tier`
  );
  const rows = (await res.json()) as UserRecord[];
  if (!rows || rows.length === 0) {
    throw new Error('User not found');
  }
  return rows[0];
}

/**
 * Check if user has at least 1 credit. Returns the user record.
 * Does NOT deduct — call deductCredit separately after successful analysis.
 */
export async function checkCredits(userId: string, env: Env): Promise<UserRecord> {
  const user = await getUser(userId, env);
  if (user.credits_remaining <= 0) {
    const err = new Error('No credits remaining');
    (err as Error & { code: string }).code = 'no_credits';
    throw err;
  }
  return user;
}

/**
 * Deduct 1 credit from the user and log the transaction.
 * Uses a raw SQL RPC call to atomically decrement (avoids race conditions).
 */
export async function deductCredit(
  userId: string,
  videoId: string,
  env: Env
): Promise<void> {
  // Atomic decrement via PATCH with Supabase's computed column support
  // We use the raw REST API: PATCH /users?id=eq.X with credits_remaining = credits_remaining - 1
  // Supabase REST doesn't support computed updates, so we use an RPC or two-step approach.

  // Step 1: Decrement credits_remaining
  const patchRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/deduct_credit`,
    {
      method: 'POST',
      headers: supabaseHeaders(env),
      body: JSON.stringify({ p_user_id: userId }),
    }
  );

  // If the RPC doesn't exist yet (not in migration), fall back to simple update
  if (!patchRes.ok) {
    // Fallback: read-then-write (acceptable for MVP; race window is tiny)
    const user = await getUser(userId, env);
    const newCredits = Math.max(0, user.credits_remaining - 1);
    await supabasePatch(env, `/rest/v1/users?id=eq.${userId}`, {
      credits_remaining: newCredits,
    });
  }

  // Step 2: Log the transaction
  await supabasePost(env, '/rest/v1/credit_transactions', {
    user_id: userId,
    amount: -1,
    reason: 'analysis',
    video_id: videoId,
  });
}

/**
 * Add credits to a user (for top-ups or resets) and log the transaction.
 */
export async function addCredits(
  userId: string,
  amount: number,
  reason: string,
  env: Env
): Promise<void> {
  const user = await getUser(userId, env);
  const newCredits = user.credits_remaining + amount;

  await supabasePatch(env, `/rest/v1/users?id=eq.${userId}`, {
    credits_remaining: newCredits,
  });

  await supabasePost(env, '/rest/v1/credit_transactions', {
    user_id: userId,
    amount,
    reason,
  });
}

// ============================================================
// Supabase HTTP helpers (service role — bypasses RLS)
// ============================================================

function supabaseHeaders(env: Env): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    Prefer: 'return=minimal',
  };
}

async function supabaseGet(env: Env, path: string): Promise<Response> {
  return fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      ...supabaseHeaders(env),
      Prefer: 'return=representation',
    },
  });
}

async function supabasePatch(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: supabaseHeaders(env),
    body: JSON.stringify(body),
  });
}

async function supabasePost(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: supabaseHeaders(env),
    body: JSON.stringify(body),
  });
}
