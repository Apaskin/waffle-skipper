// auth.ts — JWT verification middleware.
// Extracts the Supabase JWT from the Authorization header, verifies it
// against Supabase's JWKS endpoint, and returns the authenticated user ID.

import type { Env } from '../index';

interface SupabaseJwtPayload {
  sub: string;   // user ID (uuid)
  email?: string;
  role?: string;
  exp?: number;
}

/**
 * Verify the Supabase JWT from the Authorization: Bearer header.
 * Returns the user_id (uuid) or throws with a descriptive error.
 *
 * We use Supabase's /auth/v1/user endpoint for verification rather
 * than manual JWKS parsing — simpler and always consistent with
 * Supabase's own auth state.
 */
export async function verifyAuth(request: Request, env: Env): Promise<string> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header', 401);
  }

  const token = authHeader.slice(7);
  if (!token) {
    throw new AuthError('Empty bearer token', 401);
  }

  // Call Supabase to verify the token and get the user
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_SERVICE_KEY,
    },
  });

  if (!response.ok) {
    throw new AuthError('Invalid or expired token', 401);
  }

  const user = (await response.json()) as { id?: string };
  if (!user?.id) {
    throw new AuthError('Could not resolve user from token', 401);
  }

  return user.id;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}
