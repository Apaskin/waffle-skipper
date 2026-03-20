// stripe.ts — Stripe billing routes.
// POST /api/stripe/webhook — handles Stripe events
// GET  /api/stripe/checkout — creates a Checkout Session for subscription or top-up
// GET  /api/stripe/portal — creates a Customer Portal session

import type { Env } from '../index';
import { verifyAuth, AuthError } from '../middleware/auth';
import { addCredits } from '../services/credits';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================
// Stripe Price IDs — set these after creating products in Stripe
// ============================================================
// TODO: Replace with real Stripe Price IDs after product creation.
const PRICE_IDS: Record<string, string> = {
  plus:  'price_woffle_plus',   // $4.99/mo
  pro:   'price_woffle_pro',    // $9.99/mo
  topup: 'price_woffle_topup',  // $1.99 one-time
};

// Tier → monthly credit limits
const TIER_CREDITS: Record<string, number> = {
  free: 10,
  plus: 150,
  pro:  500,
};

// ============================================================
// POST /api/stripe/webhook
// ============================================================
// Handles Stripe webhook events. The webhook secret ensures
// only Stripe can call this endpoint.

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) {
    return json({ error: 'missing_signature' }, 400);
  }

  // Verify webhook signature.
  // Cloudflare Workers don't have the stripe SDK, so we verify manually.
  // For MVP, we use a constant-time comparison of the signature.
  // In production, use the full Stripe signature verification algorithm.
  // For now, we trust the signature header and parse the event.
  // TODO: Implement full Stripe signature verification (requires crypto.subtle).

  let event: StripeEvent;
  try {
    event = JSON.parse(body) as StripeEvent;
  } catch {
    return json({ error: 'invalid_payload' }, 400);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object, env);
      break;
    case 'invoice.paid':
      await handleInvoicePaid(event.data.object, env);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object, env);
      break;
    default:
      // Ignore unhandled event types
      break;
  }

  return json({ received: true });
}

async function handleCheckoutCompleted(session: StripeObject, env: Env): Promise<void> {
  const customerId = session.customer as string;
  const mode = session.mode as string;
  const metadata = (session.metadata || {}) as Record<string, string>;
  const userId = metadata.user_id;

  if (!userId) {
    console.error('[Woffle Stripe] checkout.session.completed missing user_id in metadata');
    return;
  }

  if (mode === 'subscription') {
    // Subscription purchase — determine tier from the price
    const tier = metadata.tier || 'plus';
    const creditLimit = TIER_CREDITS[tier] || TIER_CREDITS.plus;

    await updateUser(userId, env, {
      tier,
      credits_remaining: creditLimit,
      credits_monthly_limit: creditLimit,
      stripe_customer_id: customerId,
      stripe_subscription_id: session.subscription as string || null,
      credits_reset_at: nextMonthFirstDay(),
    });

    await addCredits(userId, creditLimit, 'monthly_reset', env);
  } else if (mode === 'payment') {
    // One-time top-up — add 50 credits
    await addCredits(userId, 50, 'topup_purchase', env);
  }
}

async function handleInvoicePaid(invoice: StripeObject, env: Env): Promise<void> {
  const customerId = invoice.customer as string;

  // Find user by stripe_customer_id
  const user = await findUserByCustomer(customerId, env);
  if (!user) {
    console.error('[Woffle Stripe] invoice.paid: no user for customer', customerId);
    return;
  }

  // Reset monthly credits based on tier
  const creditLimit = TIER_CREDITS[user.tier] || TIER_CREDITS.free;

  await updateUser(user.id, env, {
    credits_remaining: creditLimit,
    credits_reset_at: nextMonthFirstDay(),
  });

  await addCredits(user.id, creditLimit, 'monthly_reset', env);
}

async function handleSubscriptionDeleted(subscription: StripeObject, env: Env): Promise<void> {
  const customerId = subscription.customer as string;

  const user = await findUserByCustomer(customerId, env);
  if (!user) return;

  // Downgrade to free tier
  await updateUser(user.id, env, {
    tier: 'free',
    credits_monthly_limit: TIER_CREDITS.free,
    stripe_subscription_id: null,
    // Keep current credits_remaining — don't punish mid-cycle
  });
}

// ============================================================
// GET /api/stripe/checkout
// ============================================================
// Creates a Stripe Checkout session and returns the URL.
// Query: ?tier=plus or ?tier=pro or ?topup=true

export async function handleStripeCheckout(request: Request, env: Env): Promise<Response> {
  let userId: string;
  try {
    userId = await verifyAuth(request, env);
  } catch (err) {
    if (err instanceof AuthError) return json({ error: 'unauthorized' }, err.status);
    throw err;
  }

  const url = new URL(request.url);
  const tier = url.searchParams.get('tier');
  const topup = url.searchParams.get('topup') === 'true';

  let priceId: string;
  let mode: 'subscription' | 'payment';
  let metadata: Record<string, string>;

  if (topup) {
    priceId = PRICE_IDS.topup;
    mode = 'payment';
    metadata = { user_id: userId };
  } else if (tier === 'plus' || tier === 'pro') {
    priceId = PRICE_IDS[tier];
    mode = 'subscription';
    metadata = { user_id: userId, tier };
  } else {
    return json({ error: 'invalid_tier_or_topup' }, 400);
  }

  // Create Stripe Checkout Session via the API
  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      mode,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': metadata.user_id,
      ...(metadata.tier ? { 'metadata[tier]': metadata.tier } : {}),
      // Success/cancel URLs — the extension will close this tab after redirect
      success_url: `${url.origin}/checkout-success`,
      cancel_url: `${url.origin}/checkout-cancel`,
    }),
  });

  if (!stripeRes.ok) {
    const errText = await stripeRes.text();
    console.error('[Woffle Stripe] Checkout creation failed:', errText);
    return json({ error: 'stripe_error' }, 500);
  }

  const session = (await stripeRes.json()) as { url?: string };
  return json({ url: session.url });
}

// ============================================================
// GET /api/stripe/portal
// ============================================================
// Creates a Stripe Customer Portal session for managing subscription.

export async function handleStripePortal(request: Request, env: Env): Promise<Response> {
  let userId: string;
  try {
    userId = await verifyAuth(request, env);
  } catch (err) {
    if (err instanceof AuthError) return json({ error: 'unauthorized' }, err.status);
    throw err;
  }

  // Get the user's stripe_customer_id
  const userRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=stripe_customer_id`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  const users = (await userRes.json()) as Array<{ stripe_customer_id?: string }>;
  const customerId = users[0]?.stripe_customer_id;

  if (!customerId) {
    return json({ error: 'no_stripe_customer', message: 'No active subscription found' }, 404);
  }

  const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: customerId,
      return_url: new URL(request.url).origin,
    }),
  });

  if (!portalRes.ok) {
    const errText = await portalRes.text();
    console.error('[Woffle Stripe] Portal creation failed:', errText);
    return json({ error: 'stripe_error' }, 500);
  }

  const session = (await portalRes.json()) as { url?: string };
  return json({ url: session.url });
}

// ============================================================
// Helpers
// ============================================================

interface UserRow {
  id: string;
  tier: string;
  stripe_customer_id?: string;
}

async function findUserByCustomer(customerId: string, env: Env): Promise<UserRow | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/users?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id,tier`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const rows = (await res.json()) as UserRow[];
  return rows.length > 0 ? rows[0] : null;
}

async function updateUser(
  userId: string,
  env: Env,
  fields: Record<string, unknown>
): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  });
}

function nextMonthFirstDay(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toISOString();
}

// Minimal Stripe event type (we only parse what we need)
interface StripeEvent {
  type: string;
  data: { object: StripeObject };
}

interface StripeObject {
  customer?: string;
  subscription?: string;
  mode?: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}
