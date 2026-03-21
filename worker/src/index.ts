// index.ts — Main Cloudflare Worker entry point and router.
// All requests hit this file, get routed to the appropriate handler.

import { handleAnalyse, handleGetAnalysis } from './routes/analyse';
import { handleMe } from './routes/auth';
import { handleChannels } from './routes/channels';
import {
  handleStripeCheckout,
  handleStripePortal,
  handleStripeWebhook,
} from './routes/stripe';

export interface Env {
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  PROMPT_VERSION: string;
}

// Standard JSON response helpers
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let response: Response;

    try {
      // Route matching
      if (method === 'POST' && path === '/api/analyse') {
        response = await handleAnalyse(request, env, ctx);
      } else if (method === 'GET' && path.startsWith('/api/analyse/')) {
        const videoId = path.replace('/api/analyse/', '');
        response = await handleGetAnalysis(request, env, videoId);
      } else if (method === 'GET' && path === '/api/me') {
        response = await handleMe(request, env);
      } else if (method === 'POST' && path === '/api/channels') {
        response = await handleChannels(request, env);
      } else if (method === 'POST' && path === '/api/stripe/webhook') {
        response = await handleStripeWebhook(request, env);
      } else if (method === 'GET' && path === '/api/stripe/checkout') {
        response = await handleStripeCheckout(request, env);
      } else if (method === 'GET' && path === '/api/stripe/portal') {
        response = await handleStripePortal(request, env);
      } else {
        response = json({ error: 'not_found' }, 404);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      console.error('[Woffle Worker] Unhandled error:', message);
      response = json({ error: 'internal_error', message }, 500);
    }

    // Attach CORS headers to every response
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      headers.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
};
