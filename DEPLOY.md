# DEPLOY.md — Woffle Backend Deployment Guide

Step-by-step instructions to go from a fresh repo to a live, working backend.
Complete every section in order — later steps depend on values from earlier steps.

---

## Prerequisites

- [x] Node.js 18+ installed
- [x] Wrangler CLI: `npm install -g wrangler`
- [x] Supabase CLI: `npm install -g supabase`
- [x] A Supabase account
- [x] A Stripe account (test mode first)
- [x] A Cloudflare account (free tier works)
- [x] An Anthropic API key

---

## Step 1 — Create the Supabase Project

1. Go to https://supabase.com → **New project**
2. Name it `woffle` (or whatever you like)
3. Choose a region close to your users
4. Set a strong database password — save it somewhere
5. Wait for provisioning (~60 seconds)

**Collect these values from Project Settings → API:**

| Value | Where to find it |
|-------|-----------------|
| `SUPABASE_URL` | Project URL (e.g. `https://abcdefgh.supabase.co`) |
| `SUPABASE_ANON_KEY` | `anon` / `public` key |
| `SUPABASE_SERVICE_KEY` | `service_role` key (keep secret) |

---

## Step 2 — Run the Database Migration

```bash
cd /path/to/WOFFLE

# Link to your Supabase project (you'll be prompted to paste your project ref)
npx supabase link --project-ref YOUR_PROJECT_REF

# Apply the migration (creates users, analyses, credit_transactions tables + RPCs)
npx supabase db push
```

Your `PROJECT_REF` is the subdomain part of your Supabase URL:
`https://abcdefgh.supabase.co` → project ref is `abcdefgh`

**Verify in Supabase Dashboard → Table Editor:**
- `users` table exists
- `analyses` table exists
- `credit_transactions` table exists

**Verify RPC functions exist in Dashboard → Database → Functions:**
- `deduct_credit`
- `increment_access_count`

---

## Step 3 — Create Stripe Products and Prices

Log in to https://dashboard.stripe.com (use **Test mode** first).

### 3a — Create Plus subscription

1. **Products** → **Add product**
2. Name: `Woffle Plus`
3. Description: `150 video scans per month`
4. Pricing model: **Recurring**
5. Price: `$4.99` / month
6. Click **Save product**
7. Copy the **Price ID** (starts with `price_`) — you'll need it

### 3b — Create Pro subscription

1. **Products** → **Add product**
2. Name: `Woffle Pro`
3. Description: `500 video scans per month`
4. Pricing model: **Recurring**
5. Price: `$9.99` / month
6. Click **Save product**
7. Copy the **Price ID**

### 3c — Create Top-up (one-time)

1. **Products** → **Add product**
2. Name: `Woffle Credits Top-up`
3. Description: `+50 scans`
4. Pricing model: **One time**
5. Price: `$1.99`
6. Click **Save product**
7. Copy the **Price ID**

**Collect:**

| Constant | Value |
|----------|-------|
| `PRICE_IDS.plus` | `price_XXXXXXXX` |
| `PRICE_IDS.pro` | `price_XXXXXXXX` |
| `PRICE_IDS.topup` | `price_XXXXXXXX` |

---

## Step 4 — Update Price IDs in the Worker

Open `worker/src/routes/stripe.ts` and replace the placeholder values:

```typescript
const PRICE_IDS: Record<string, string> = {
  plus:  'price_XXXXXXXX',   // replace with your real Plus price ID
  pro:   'price_XXXXXXXX',   // replace with your real Pro price ID
  topup: 'price_XXXXXXXX',   // replace with your real Top-up price ID
};
```

---

## Step 5 — Deploy the Cloudflare Worker

```bash
cd worker

# Install dependencies
npm install

# Log in to Cloudflare (opens browser)
wrangler login

# Deploy the worker
wrangler deploy
```

Wrangler will print the deployed URL:
```
Published woffle-api (X.XXs)
  https://woffle-api.YOUR_SUBDOMAIN.workers.dev
```

Save this URL — it is your `WORKER_URL`.

---

## Step 6 — Set Worker Secrets

These are environment variables that are **never** stored in wrangler.toml (they're secret).

```bash
cd worker

wrangler secret put ANTHROPIC_API_KEY
# Paste your Anthropic API key when prompted

wrangler secret put SUPABASE_URL
# Paste your Supabase project URL (e.g. https://abcdefgh.supabase.co)

wrangler secret put SUPABASE_SERVICE_KEY
# Paste your Supabase service_role key (NOT the anon key)

wrangler secret put STRIPE_SECRET_KEY
# Paste your Stripe secret key (sk_test_... for test mode, sk_live_... for prod)

wrangler secret put STRIPE_WEBHOOK_SECRET
# You will get this value in Step 7 — come back and set it then
```

**Verify secrets are set:**
```bash
wrangler secret list
```

You should see all five secrets listed (values are hidden).

---

## Step 7 — Register the Stripe Webhook

1. Go to Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**

2. **Endpoint URL:**
   ```
   https://woffle-api.YOUR_SUBDOMAIN.workers.dev/api/stripe/webhook
   ```

3. **Events to listen to** (click "+ Select events", search and add each):
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.deleted`

4. Click **Add endpoint**

5. On the webhook detail page, click **Reveal** next to **Signing secret**

6. Copy the signing secret (starts with `whsec_`)

7. Back in your terminal:
   ```bash
   cd worker
   wrangler secret put STRIPE_WEBHOOK_SECRET
   # Paste the whsec_... value
   ```

---

## Step 8 — Update the Extension Config

Open `background.js` and replace the three placeholder values in `WOFFLE_CONFIG`:

```javascript
const WOFFLE_CONFIG = {
  // Your deployed Cloudflare Worker URL from Step 5
  WORKER_URL: 'https://woffle-api.YOUR_SUBDOMAIN.workers.dev',

  // Your Supabase project URL from Step 1
  SUPABASE_URL: 'https://abcdefgh.supabase.co',

  // Your Supabase anon/public key from Step 1 (NOT the service_role key)
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
};
```

> **Why the anon key here?** The extension only uses the anon key for auth
> (login/signup/refresh). All protected operations go through the Worker,
> which uses the service_role key. Never put the service_role key in the extension.

---

## Step 9 — Load the Extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `WOFFLE` folder (the one containing `manifest.json`)
5. The 🧇 Woffle extension icon should appear in your toolbar

---

## Step 10 — Smoke Test Checklist

Work through these in order. Each step confirms the previous one worked.

### Auth

- [ ] Open Woffle options page (click extension icon → gear, or right-click → Options)
- [ ] Sign up with a test email — should show "ACCOUNT CREATED ✓" or "CHECK YOUR EMAIL TO CONFIRM"
- [ ] If email confirmation required, confirm it then sign in
- [ ] After sign-in, the account section should show: email, tier = FREE, credits = 10 / 10

### Analysis (shared cache miss → fresh AI call)

- [ ] Navigate to any YouTube video
- [ ] Click the 🧇 button in the YouTube player controls
- [ ] Button should enter `.scanning` state (pulsing orange)
- [ ] After 5-30 seconds, timeline bar should appear with coloured segments
- [ ] Button should enter `.done` state
- [ ] Credits counter in popup should decrease by 1 (9 / 10)

### Shared cache hit (zero credits)

- [ ] Navigate to the **same** YouTube video again
- [ ] Click the 🧇 button
- [ ] Analysis should appear **instantly** (from local cache, no network)
- [ ] Navigate to the video in a different Chrome profile (if you have one) or incognito
- [ ] Analysis should appear quickly (from shared backend cache, no AI call, no credit deducted)

### Segment hover + skip

- [ ] Hover over a coloured segment in the timeline bar
- [ ] Tooltip should appear with segment label, time range, and description
- [ ] Let a waffle segment play — it should auto-skip

### Stripe (test mode)

- [ ] In popup, click **UPGRADE**
- [ ] Stripe Checkout should open in a new tab
- [ ] Use test card: `4242 4242 4242 4242`, any future expiry, any CVC
- [ ] After successful checkout, options page should show tier = PLUS ⚡, credits = 150 / 150
- [ ] In Stripe Dashboard → Webhooks → your endpoint → check Recent deliveries
- [ ] `checkout.session.completed` should show status 200

### Top-up (test mode)

- [ ] In popup, click **BUY CREDITS**
- [ ] Stripe Checkout opens (one-time payment)
- [ ] Complete with test card
- [ ] Credits should increase by 50

### Customer Portal

- [ ] In options page, click **MANAGE SUBSCRIPTION**
- [ ] Stripe Customer Portal should open
- [ ] Cancel the test subscription
- [ ] Tier should revert to FREE (may take a few seconds for webhook to fire)

---

## Step 11 — Go Live (when ready)

1. **Stripe:** Switch from Test mode to Live mode — create new Live mode products and prices (repeat Step 3), get a new live `sk_live_...` key and live webhook signing secret
2. **Worker secrets:** Re-run `wrangler secret put` for `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` with live values
3. **Extension:** Update `WOFFLE_CONFIG.SUPABASE_ANON_KEY` if different between environments (usually the same project)
4. **Chrome Web Store:** Package the extension (`zip` the folder contents, not the folder itself) and submit

---

## Troubleshooting

### Worker returns 500 on `/api/analyse`

Check `wrangler tail` (live logs):
```bash
cd worker
wrangler tail
```
Most common causes: missing `ANTHROPIC_API_KEY` secret, Supabase migration not applied.

### "GAME OVER — SIGN IN FIRST" in popup

The extension can't reach the Worker or Supabase. Check:
1. `WOFFLE_CONFIG.WORKER_URL` matches the deployed URL exactly (no trailing slash)
2. `WOFFLE_CONFIG.SUPABASE_URL` and `SUPABASE_ANON_KEY` are correct
3. Reload the extension after any `background.js` changes

### Stripe webhook shows 401

The `STRIPE_WEBHOOK_SECRET` doesn't match. Verify:
1. You used the signing secret from the **correct** webhook endpoint (not a different one)
2. `wrangler secret list` shows `STRIPE_WEBHOOK_SECRET`
3. The secret starts with `whsec_`

### Credits not resetting after `invoice.paid`

Check Stripe webhook Recent deliveries for `invoice.paid`. If it's failing:
- Confirm the user has a `stripe_customer_id` set (check Supabase `users` table)
- Check `wrangler tail` for the error

### Analysis hangs in scanning state forever

YouTube changed their transcript API response format. Check browser console on a YouTube page for `[Woffle]` errors from `content.js`. The transcript fetching runs in the content script, which passes chunks to the background script.
