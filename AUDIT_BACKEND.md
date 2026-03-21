# WOFFLE — Backend Infrastructure Audit

**Date**: 2026-03-21
**Auditor**: Claude Opus 4.6
**Scope**: `worker/` (Cloudflare Worker) and `supabase/` (schema, RPC functions, RLS policies)
**Approach**: Full read of every source file and the SQL migration. Cross-referenced against `background.js` and `options.js` for integration points.

---

## 1. File Inventory

### Worker (`worker/`)

| File | Lines | Purpose |
|---|---|---|
| `src/index.ts` | 89 | Main entry point — router, CORS, error handling |
| `src/middleware/auth.ts` | 60 | JWT verification via Supabase `/auth/v1/user` endpoint |
| `src/routes/analyse.ts` | 202 | POST (two-pass analysis) and GET (cache lookup) for video classification |
| `src/routes/auth.ts` | 66 | GET `/api/me` — returns user tier, credits, channels |
| `src/routes/channels.ts` | 89 | POST `/api/channels` — manages auto-analyse channel list |
| `src/routes/stripe.ts` | 411 | Stripe webhook, checkout session creation, customer portal |
| `src/services/cache.ts` | 112 | Shared analysis cache read/write/increment via Supabase |
| `src/services/claude.ts` | 636 | Claude API calls — Haiku quick scan, Sonnet streaming + fallback, JSON parsing |
| `src/services/credits.ts` | 163 | Credit check, atomic deduction (RPC), addCredits, Supabase helpers |
| `wrangler.toml` | 13 | Worker config — name, entry point, PROMPT_VERSION var |
| `package.json` | 15 | Dependencies: wrangler, @cloudflare/workers-types, typescript |
| `tsconfig.json` | 16 | TypeScript config — strict, ES2022, Cloudflare types |

### Supabase (`supabase/`)

| File | Lines | Purpose |
|---|---|---|
| `migrations/001_initial_schema.sql` | 200 | Full schema: tables, types, RLS, triggers, RPC functions |
| `config.toml` | 1 | Supabase project ID reference |

**Total backend code**: ~1,857 lines across 10 source files + 1 migration.

---

## 2. Cloudflare Worker Architecture

### Routes

| Method | Path | Auth | Called by Extension? | Status |
|---|---|---|---|---|
| `POST` | `/api/analyse` | JWT | ✅ Yes (`background.js` lines 743, 768) | ✅ Working |
| `GET` | `/api/analyse/:video_id` | JWT | ✅ Yes (`background.js` line 702) | ✅ Working |
| `GET` | `/api/me` | JWT | ✅ Yes (`background.js` line 642, `popup.js` line 153) | ✅ Working |
| `POST` | `/api/channels` | JWT | ❌ **Not called** | 🗑️ Dead route |
| `POST` | `/api/stripe/webhook` | Stripe signature | N/A (Stripe calls this) | ✅ Working |
| `GET` | `/api/stripe/checkout` | JWT | ✅ Yes (`background.js` line 655) | ✅ Working |
| `GET` | `/api/stripe/portal` | JWT | ✅ Yes (`background.js` line 572) | ✅ Working |

**Dead route**: `POST /api/channels` is fully implemented (89 lines, tier checks, validation) but is never called from the extension. The channel auto-analyse feature is not implemented in the extension frontend. **Not harmful**, but dead code.

### API Calls — Model IDs

Hardcoded model strings:
- **Haiku**: `'claude-haiku-4-5-20251001'` (`claude.ts:35`)
- **Sonnet**: `'claude-sonnet-4-5-20250929'` (`claude.ts:36`) — uncommitted change from `'claude-sonnet-4-5-20250514'`
- **Cache metadata**: `'claude-sonnet-4-5-20250929'` hardcoded in `analyse.ts:118,151` — duplicated from `claude.ts`, should reference the constant

⚠️ **Issue**: The model ID string is hardcoded in THREE places (`claude.ts:36`, `analyse.ts:118`, `analyse.ts:151`). When updating the model, all three must be changed. The `analyse.ts` references should use the `SONNET_MODEL` constant from `claude.ts` instead.

### Streaming Implementation

✅ **Well implemented**

1. `classifyFullTranscriptStreaming()` creates a `TransformStream`.
2. Calls Anthropic API with `stream: true`.
3. Reads Anthropic's SSE stream chunk by chunk.
4. Uses custom `parseIncremental()` to extract complete segment JSON objects from partial text by tracking brace depth (properly handles strings with escaped quotes).
5. Emits each segment as an SSE `event: segment` to the client immediately.
6. After stream completes, runs `parseFinal()` to catch any remaining segments.
7. Merges adjacent segments with same category and close confidence.
8. Uses `ctx.waitUntil()` to keep the worker alive for cache write + credit deduction after response body finishes.
9. Has a non-streaming fallback (`classifyFullTranscript()`) if streaming setup fails.

### System Prompts

**Quick Intro Prompt** (Haiku — `claude.ts:42-54`):
Simple and focused. Detects where intro ends, expects JSON response with `intro_ends_at`, `intro_type`, `topic_starts`.

**Full Classification Prompt** (Sonnet — `claude.ts:63-136`):
Version v3.0. Comprehensive, well-structured prompt. Key features:
- Topic-anchored analysis (Step 1: identify topic, judge everything against it)
- Natural segmentation (not fixed intervals)
- Confidence scoring 0-100 with detailed rubric
- 10 category types (sponsor, self_promo, pleasantries, tangent, repetition, cohost_echo, filler, intro_outro, context, substance)
- Podcast/interview rules (co-host echo detection)
- Aggressiveness instruction ("a typical 10-minute video has 2-4 minutes of woffle")
- JSON-only response format

**Prompt version**: `v3.0` (set in `wrangler.toml` as `PROMPT_VERSION`). Cache is keyed by `(video_id, prompt_version)`, so bumping this automatically invalidates stale cache entries.

### Transcript Format Sent to Claude

The transcript is sent as a single timestamped block:
```
Video title: "Example Title"
Video duration: 15 minutes

Full transcript:
[0:00] First chunk of text
[0:04] Second chunk of text
...
```

The extension pre-chunks the transcript into 4-8 second segments (done in `background.js:chunkTranscript()`), then the worker concatenates them with timestamps. Entire transcript sent in one API call — no chunking at the API level.

### Error Handling

| Scenario | Response | Assessment |
|---|---|---|
| Claude API error | 502 with `classification_failed` + detail | ✅ Good |
| Auth failure | 401 with `unauthorized` | ✅ Good |
| No credits | 402 with `no_credits` | ✅ Good |
| Invalid JSON body | 400 with `invalid_json` | ✅ Good |
| Missing video_id | 400 with `missing_video_id` | ✅ Good |
| Supabase unreachable | 500 with `failed_to_fetch_user` or uncaught | ⚠️ Some paths don't catch |
| Stripe webhook bad signature | 401 with `invalid_signature` | ✅ Good |
| Unhandled exception | 500 with `internal_error` + message | ✅ Good (catch-all in index.ts) |

⚠️ **Gap**: If the Supabase REST API is down, `getUser()` will throw an unhandled error. The catch-all in `index.ts` handles it with a 500, but the error message will be opaque ("fetch failed" or similar). Not critical since Supabase downtime is rare.

### CORS

```typescript
corsHeaders(origin) = {
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}
```

⚠️ **Overly permissive**: Reflects ANY origin back. This means any website can make authenticated requests to the API if they have the JWT. In practice, the JWT is stored in `chrome.storage.local` which is inaccessible to websites, so the risk is low. But for defense-in-depth, should restrict to known origins.

✅ **chrome-extension:// origin**: Works correctly — `origin || '*'` handles the case where no Origin header is sent (which happens with some extension requests).

✅ **Preflight OPTIONS**: Handled at the top of the router with 204 response.

---

## 3. Supabase Schema

### Tables

#### `users`
| Column | Type | Constraints | Default |
|---|---|---|---|
| `id` | uuid | PK, FK → auth.users ON DELETE CASCADE | — |
| `email` | text | NOT NULL | — |
| `tier` | user_tier (enum) | NOT NULL | `'free'` |
| `credits_remaining` | int | NOT NULL | `10` |
| `credits_monthly_limit` | int | NOT NULL | `10` |
| `credits_reset_at` | timestamptz | NOT NULL | First day of next month |
| `stripe_customer_id` | text | — | NULL |
| `stripe_subscription_id` | text | — | NULL |
| `auto_analyse_channels` | jsonb | NOT NULL | `'[]'` |
| `tier_updated_at` | timestamptz | NOT NULL | `now()` |
| `created_at` | timestamptz | NOT NULL | `now()` |
| `updated_at` | timestamptz | NOT NULL | `now()` (auto-updated by trigger) |

**Indexes**: `idx_users_stripe_customer` on `stripe_customer_id` (partial, WHERE NOT NULL) — for webhook lookups.

#### `analyses`
| Column | Type | Constraints | Default |
|---|---|---|---|
| `id` | uuid | PK | `gen_random_uuid()` |
| `video_id` | text | NOT NULL | — |
| `video_title` | text | — | NULL |
| `video_duration_seconds` | int | — | NULL |
| `segments` | jsonb | NOT NULL | `'[]'` |
| `model_used` | text | — | NULL |
| `prompt_version` | text | NOT NULL | — |
| `created_at` | timestamptz | NOT NULL | `now()` |
| `requested_by` | uuid | FK → users ON DELETE SET NULL | NULL |
| `access_count` | int | NOT NULL | `1` |

**Indexes**: `idx_analyses_video_prompt` — UNIQUE on `(video_id, prompt_version)`. Handles duplicate-insert races via `ON CONFLICT` in the cache write.

#### `credit_transactions`
| Column | Type | Constraints | Default |
|---|---|---|---|
| `id` | uuid | PK | `gen_random_uuid()` |
| `user_id` | uuid | NOT NULL, FK → users ON DELETE CASCADE | — |
| `amount` | int | NOT NULL | — |
| `reason` | credit_reason (enum) | NOT NULL | — |
| `video_id` | text | — | NULL |
| `created_at` | timestamptz | NOT NULL | `now()` |

**Indexes**: `idx_credit_tx_user` on `(user_id, created_at DESC)`.

### RLS Policies

| Table | Policy | Role | Operation | Rule | Assessment |
|---|---|---|---|---|---|
| `users` | "Users can read own record" | default | SELECT | `auth.uid() = id` | ✅ Secure |
| `analyses` | "Analyses are readable by all authenticated users" | authenticated | SELECT | `true` | ✅ Correct (shared cache) |
| `credit_transactions` | "Users can read own transactions" | default | SELECT | `auth.uid() = user_id` | ✅ Secure |

**Missing policies**: No INSERT/UPDATE/DELETE policies on any table for the `authenticated` role. This means:
- ✅ Users CANNOT insert/update/delete their own records via the client SDK
- ✅ Only the service role (used by the Worker) can write data
- ✅ This is the intended design — all writes go through the Worker

**Security assessment**: ✅ No policy exploitation possible. User A cannot read User B's `users` row or `credit_transactions`. The `analyses` table is intentionally public-read among authenticated users (it's a shared cache).

### RPC Functions

| Function | Purpose | Called by | Assessment |
|---|---|---|---|
| `deduct_credit(p_user_id uuid)` | Atomic `UPDATE ... WHERE credits_remaining > 0 RETURNING credits_remaining`. Returns -1 if no credits. | Worker `credits.ts` | ✅ Correct, atomic |
| `increment_access_count(p_analysis_id uuid)` | Atomic `UPDATE analyses SET access_count = access_count + 1` | Worker `cache.ts` | ✅ Correct, fire-and-forget |

Both are `SECURITY DEFINER` — they execute with the function owner's privileges, bypassing RLS. This is correct since they're called via the service role from the Worker.

### Auth Configuration

- ✅ Email auth: Enabled (Supabase default).
- ❓ Email confirmation: Cannot verify from code — depends on Supabase dashboard setting. The extension `options.js` handles both confirmed (`result.confirmed === true`) and unconfirmed flows.
- ✅ Auth trigger: `on_auth_user_created` fires `handle_new_user()` which auto-creates a `users` row with free-tier defaults (10 credits).
- ✅ `updated_at` trigger: Fires on any `users` row update.

---

## 4. Stripe Integration

### Products & Prices

| Product | Price ID | Amount | Mode |
|---|---|---|---|
| Woffle Plus | `price_1TD48yEe9LBq3CUYtMoqbZhd` | $4.99/mo | subscription |
| Woffle Pro | `price_1TD49hEe9LBq3CUYWQjzen0c` | $9.99/mo | subscription |
| Credit Top-up | `price_1TD4ABEe9LBq3CUY8GjjLSpo` | $1.99 one-time | payment |

Price IDs are **hardcoded** in `stripe.ts:21-25`. They appear to be real Stripe price IDs (format matches Stripe's ID scheme). These should ideally be in environment variables, but since they're non-secret (Stripe price IDs are public in checkout URLs), this is acceptable.

### Webhook Handler

**Signature verification**: ✅ **Properly implemented**
- Uses `crypto.subtle.importKey` + `crypto.subtle.sign` for HMAC-SHA256.
- Parses `t=` timestamp and `v1=` signatures from header.
- Replay protection: rejects timestamps older than 5 minutes.
- **Constant-time comparison** via `constantTimeEqual()` — prevents timing attacks. ✅ Good security practice.

**Events handled**:

| Event | Handler | Idempotent? | Assessment |
|---|---|---|---|
| `checkout.session.completed` | Sets tier, credits, Stripe IDs, resets credits | ⚠️ Partially | See below |
| `invoice.paid` | Resets monthly credits based on tier | ⚠️ Partially | See below |
| `customer.subscription.deleted` | Downgrades to free tier | ✅ Yes | Keeps remaining credits |

**Idempotency concerns**:
- ⚠️ `checkout.session.completed`: If fired twice, `addCredits()` in the checkout handler does `user.credits_remaining + amount` (read-then-write), so a double-fire could double-add credits. However, the `updateUser()` call before it sets `credits_remaining: creditLimit` (an absolute set, not increment), so the credits themselves are idempotent. The problem is `addCredits()` also logs a `credit_transactions` entry — a double-fire creates duplicate audit log entries.
- ⚠️ `invoice.paid`: Same pattern — `updateUser()` sets absolute credits (idempotent), but `addCredits()` logs a duplicate transaction.
- The credit amounts would be correct (absolute set wins), but the audit log would show duplicates.

**What if webhook fires before user row exists?**: `findUserByCustomer()` returns null → handler logs error and returns. No crash. But if `checkout.session.completed` fires for a brand-new user whose `on_auth_user_created` trigger hasn't completed yet, the user row won't exist. This is unlikely (signup → checkout flow has human delay) but theoretically possible.

### Checkout Flow

1. ✅ Extension popup clicks UPGRADE → sends `GET_CHECKOUT_URL` to background
2. ✅ Background sends `GET /api/stripe/checkout?tier=plus` to Worker
3. ✅ Worker verifies JWT, creates Stripe Checkout Session with `metadata.user_id` and `metadata.tier`
4. ✅ Returns checkout URL → extension opens in new tab
5. ✅ After payment, Stripe fires `checkout.session.completed` webhook
6. ✅ Webhook handler reads `user_id` from metadata, updates tier and credits

⚠️ **Success/cancel URLs**: Set to `${url.origin}/checkout-success` and `${url.origin}/checkout-cancel` — these would be `https://woffle-api.andrewpaskin.workers.dev/checkout-success` which returns 404. These pages don't exist on the Worker. The user sees a 404 page after checkout. Should redirect to a proper "thank you" page or back to the extension.

### Portal

✅ **Implemented**. Creates Stripe Customer Portal session. User can cancel/change subscription. Returns URL opened in new tab. Handles missing `stripe_customer_id` with 404 and descriptive message.

---

## 5. Credit System

### Credit Deduction
✅ **Atomic via RPC**. `deduct_credit(p_user_id)` uses `UPDATE ... WHERE credits_remaining > 0 RETURNING credits_remaining`. Row-level lock prevents concurrent over-deduction. Returns -1 if no credits available.

### Concurrent Request Protection
✅ **Handled**. The `WHERE credits_remaining > 0` guard in the RPC means two concurrent analysis requests for the same user won't both succeed if only 1 credit remains. One will get -1 back.

⚠️ **Timing gap**: Credits are checked BEFORE analysis (`checkCredits()`) but deducted AFTER analysis completes (`deductCredit()` in `waitUntil`). A user with 1 credit could theoretically fire two analyses simultaneously — both pass `checkCredits()`, both complete, both try `deductCredit()`. The RPC prevents going below 0, so one deduction succeeds and the other fails. The user gets TWO analyses for ONE credit. The second deduction error is logged but swallowed (`.catch(err => console.error(...))`).

**Impact**: Low. A user saves $0.01 worth of credits. The video was already analysed and cached. Not worth adding complexity to fix.

### Monthly Reset
**How it works**: Triggered by `invoice.paid` webhook from Stripe (fires monthly for active subscriptions). Sets `credits_remaining` to the tier's limit and logs a `monthly_reset` transaction.

⚠️ **Free tier users never reset**: There's no cron job or on-demand check for free tier credit resets. If a free user exhausts their 10 credits, they stay at 0 forever unless they upgrade. The `credits_reset_at` date is set but never checked or acted upon for free users.

**Fix needed**: Either a Cloudflare Cron Trigger or an on-demand check in `checkCredits()` that resets if `now() > credits_reset_at`.

### Credit Transaction Log
✅ Being written to. Every `deductCredit()` and `addCredits()` call inserts into `credit_transactions`.

### Zero Credits UI
✅ Handled. `checkCredits()` returns `no_credits` error → Worker returns 402 → extension shows "OUT OF CREDITS" in both the popup status and the error bar below the player.

### Negative Credits
✅ **Cannot happen**. The `deduct_credit` RPC has `WHERE credits_remaining > 0` — it can't go below 0. The `addCredits()` function only adds, never subtracts below zero.

---

## 6. Caching

### Shared Cache (analyses table)

**Cache key**: `(video_id, prompt_version)` — UNIQUE index. This means:
- ✅ Same video analysed by different users → cache hit (correct — shared cache)
- ✅ Prompt version bump → old cache entries invisible (re-analysis forced)
- ✅ Same video + same prompt → only one row (unique constraint with `resolution=ignore-duplicates`)

**Cache hit flow**:
1. `GET /api/analyse/:video_id` → Worker checks `getCachedAnalysis(videoId, env)` which queries with `prompt_version=eq.${env.PROMPT_VERSION}`
2. If found → return segments, increment access_count (fire-and-forget)
3. If not found → return `{segments: null}`
4. Extension then sends `POST /api/analyse` which also checks cache before doing fresh analysis

**Does a cache hit deduct a credit?** ✅ **No.** Both `GET /api/analyse/:videoId` and the `POST /api/analyse` cache-hit path return before reaching `checkCredits()`. Correct behaviour.

**Is access_count incremented?** ✅ Yes, via `incrementAccessCount()` RPC.

**Cache expiry/eviction**: ❌ **None.** There is no TTL, no eviction, no cleanup. The table will grow indefinitely. Old prompt versions stay forever.

**How large could this table get?** At 10K users watching unique videos: each row is ~1-5KB (JSONB segments). 100K rows = 100-500MB. Not immediately problematic but worth adding eventual cleanup for old prompt versions.

### Local Cache (chrome.storage.local)

- ✅ **What's cached**: Analysis segments keyed by `analysis_${videoId}`, with timestamp.
- ✅ **TTL**: 30 days (`LOCAL_CACHE_TTL_MS`).
- ✅ **Size limit**: 200 entries max, LRU eviction.
- ✅ **CLEAR CACHE**: Clears all `analysis_*` keys from local storage only. Does NOT signal backend (correct — shared cache should persist).

---

## 7. Security Assessment

| Check | Status | Detail |
|---|---|---|
| No hardcoded API keys in committed code | ✅ Pass | ANTHROPIC_API_KEY, STRIPE keys are in wrangler secrets |
| No secrets in wrangler.toml | ✅ Pass | Only `PROMPT_VERSION` var; secrets listed as comments |
| Supabase service key only server-side | ✅ Pass | Only in Worker via `env.SUPABASE_SERVICE_KEY` |
| Supabase anon key in extension | ✅ Pass | Acceptable — RLS protects data, anon key is designed to be public |
| JWT verification on all authenticated routes | ✅ Pass | All routes except webhook call `verifyAuth()` |
| Stripe webhook signature verification | ✅ Pass | HMAC-SHA256 with replay protection and constant-time comparison |
| postMessage origin verification | ✅ Pass | Content script checks `event.origin !== 'https://www.youtube.com'`; page-extractor posts to `'https://www.youtube.com'` (not `'*'`) |
| No eval(), new Function(), or innerHTML with unsanitised input | ⚠️ Concern | `content.js:659` uses `.innerHTML` for tooltip, but the `type` value is from `segEl.dataset.type` (controlled), `start`/`end` are from `parseFloat` (safe), and `preview` goes through `escapeHtml()`. **Safe in practice.** |
| No inline scripts in HTML files | ✅ Pass | All HTML files use external `<script src="...">` |
| CORS properly restricted | ⚠️ Concern | Reflects any origin. Low risk (JWT in extension storage, not cookies) but should be tightened for production. |

**Additional security notes**:
- ✅ The Worker uses Supabase's `/auth/v1/user` endpoint for JWT verification rather than manual JWT parsing — simpler and always consistent with Supabase's auth state.
- ✅ Stripe webhook uses raw body for signature verification (reads `request.text()` before parsing JSON).
- ✅ Credit deduction is atomic (RPC with WHERE guard).
- ⚠️ The `addCredits()` function uses read-then-write (`getUser` → `credits + amount` → `PATCH`). Not atomic, but additive operations are safe to over-credit slightly.

---

## 8. Cost Analysis

### Cost Per Video Analysis

**Sonnet 4.5 (full scan)**: Pricing is $3/MTok input, $15/MTok output.
- Average YouTube transcript (10-15 min video): ~2,000-4,000 words ≈ 3,000-6,000 tokens
- System prompt: ~600 tokens
- Total input: ~4,000-7,000 tokens → **$0.012-0.021**
- Output (segments JSON): ~500-2,000 tokens → **$0.0075-0.030**
- **Full scan cost: ~$0.02-0.05 per video** (typical ~$0.03)

**Haiku 4.5 (quick scan)**: Pricing is $0.80/MTok input, $4/MTok output.
- Input (first 90s + prompt): ~500-1,500 tokens → **$0.0004-0.0012**
- Output (JSON): ~50-100 tokens → **$0.0002-0.0004**
- **Quick scan cost: ~$0.001 per video**

**Total per fresh analysis: ~$0.03 per video** (Sonnet dominates).

### Cost Per Cached Hit

- Supabase REST API read: effectively free on free/Pro tier
- No Claude API call
- **Cost: ~$0.00**

### Monthly Infrastructure Costs

**Supabase**:
| Users | DB Rows (est.) | Plan Needed | Monthly Cost |
|---|---|---|---|
| 100 | ~5K analyses, ~3K tx | Free tier | $0 |
| 1,000 | ~50K analyses, ~30K tx | Free tier (may hit 500MB limit) | $0-25 |
| 10,000 | ~500K analyses, ~300K tx | Pro ($25/mo) | $25 |

**Cloudflare Workers**:
| Users | Requests/mo (est.) | Plan | Monthly Cost |
|---|---|---|---|
| 100 | ~10K | Free (100K/day limit) | $0 |
| 1,000 | ~100K | Free | $0 |
| 10,000 | ~1M | Paid ($5/mo + $0.50/M requests) | $5-10 |

**Claude API** (the big one):
| Users | Fresh Analyses/mo | API Cost/mo |
|---|---|---|
| 100 | ~500 (5/user avg) | ~$15 |
| 1,000 | ~5,000 | ~$150 |
| 10,000 | ~30,000 (cache hits increase) | ~$600-900 |

### Break-Even Analysis

**Plus tier ($4.99/mo, 150 analyses)**:
- At $0.03/analysis × 150 = **$4.50 API cost**
- Margin: $4.99 - $4.50 = **$0.49/user/month** (9.8% margin)
- ⚠️ **Razor thin.** One long video with a big transcript could push a single analysis to $0.08+, erasing the margin.
- If cache hit rate is 30% (plausible for popular videos): effective cost $3.15, margin $1.84 (37%). Better.

**Pro tier ($9.99/mo, 500 analyses)**:
- At $0.03/analysis × 500 = **$15.00 API cost**
- Margin: $9.99 - $15.00 = **-$5.01/user/month** ❌
- **Pro tier loses money on every user who uses their full allocation.**
- With 30% cache hit rate: $10.50 cost, still -$0.51. Still negative.

**Free tier ($0, 10 analyses)**:
- $0.30 API cost per free user per month. Acceptable acquisition cost.

**Top-up ($1.99 for 50 analyses)**:
- At $0.03 × 50 = $1.50 API cost. Margin $0.49 (25%). Viable.

### Is the Subscription Model Viable?

**Honest answer: The Pro tier is not viable at current pricing.**

The Plus tier barely breaks even. The Pro tier actively loses money. The core issue is that Sonnet 4.5 is expensive for a consumer product at this price point.

**Options to improve viability**:
1. **Use Haiku for full analysis instead of Sonnet** — 4x cheaper (~$0.008/video), massive margin improvement. Quality may drop.
2. **Reduce Pro allocation** from 500 to 200-300 analyses.
3. **Raise Pro price** to $14.99 or $19.99.
4. **Improve cache hit rates** — popular videos getting re-analysed wastes money. The shared cache already helps, but the prompt version invalidation means every prompt bump re-analyses everything.
5. **Cap transcript length** — very long videos (2+ hours) could cost $0.10+ per analysis. Truncate at 60 minutes.

---

## 9. Deployment Status

### Worker
- ✅ **Deployed** at `https://woffle-api.andrewpaskin.workers.dev`
- ✅ Worker name: `woffle-api`

### Secrets (expected in wrangler secrets)
| Secret | Expected | Can verify? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | ❓ Cannot verify from code |
| `SUPABASE_URL` | Yes | ❓ Cannot verify from code |
| `SUPABASE_SERVICE_KEY` | Yes | ❓ Cannot verify from code |
| `STRIPE_SECRET_KEY` | Yes | ❓ Cannot verify from code |
| `STRIPE_WEBHOOK_SECRET` | Yes | ❓ Cannot verify from code |

Note: `SUPABASE_URL` is listed as a secret but is non-secret (public). Could be in `[vars]` in wrangler.toml instead.

### Stripe Webhook
- ❓ Cannot verify registration from code. The webhook URL should be `https://woffle-api.andrewpaskin.workers.dev/api/stripe/webhook` registered in Stripe Dashboard.

### Supabase Project
- ✅ Project ID: `ujnpvbkncorgjqnbkfsa`
- ✅ URL matches: `https://ujnpvbkncorgjqnbkfsa.supabase.co`
- ❓ Schema migration status: Cannot verify from code whether `001_initial_schema.sql` has been run.

### Uncommitted Changes
⚠️ Two files have uncommitted changes:
- `worker/src/routes/analyse.ts` — model ID updated from `claude-sonnet-4-5-20250514` to `claude-sonnet-4-5-20250929`
- `worker/src/services/claude.ts` — same model ID update

These should be committed and deployed.

---

## 10. What's Actually Working End-to-End

### Flow 1: New user signs up → gets 10 free credits → scans a video

1. ✅ User enters email/password on options page
2. ✅ Extension sends SIGNUP to background → background calls Supabase Auth
3. ✅ Supabase creates auth.users row → trigger fires `handle_new_user()` → creates public.users row with `credits_remaining: 10`
4. ✅ User clicks SCAN → content script grabs transcript → sends ANALYZE_VIDEO
5. ✅ Background sends to Worker → Worker verifies JWT → checks credits (10 > 0) → calls Claude
6. ✅ Results stream back → timeline renders

**Verdict: ✅ Should work**

### Flow 2: User scans a video → two-pass analysis → results render

1. ✅ SCAN button → `analyzeVideo()` → `ANALYZE_VIDEO` message to background
2. ✅ Background checks local cache (miss) → checks backend cache via `GET /api/analyse/:id` (miss)
3. ✅ Background sends `POST /api/analyse` with `mode: 'quick'` AND `mode: 'full'` simultaneously
4. ✅ Quick scan returns intro skip point → content script jumps video
5. ✅ Full scan streams segments via SSE → content script renders timeline incrementally
6. ✅ `WOFFLE_COMPLETE` → final render, cache write, credit deduction

**Verdict: ✅ Should work**

### Flow 3: Second user scans the same video → cache hit

1. ✅ Second user clicks SCAN → background checks local cache (miss)
2. ✅ Background sends `GET /api/analyse/:id` → Worker finds cached entry
3. ✅ Returns cached segments → no credit deduction → `access_count++`
4. ✅ Background caches locally for future

**Verdict: ✅ Should work**

### Flow 4: User exhausts credits → UPGRADE → Stripe checkout → credits increase

1. ✅ User clicks SCAN with 0 credits → `checkCredits()` throws → 402 `no_credits` → error displayed
2. ✅ User clicks UPGRADE → background sends `GET /api/stripe/checkout?tier=plus`
3. ✅ Worker creates Stripe Checkout Session with `metadata.user_id` and `metadata.tier`
4. ✅ User completes payment → Stripe fires `checkout.session.completed`
5. ✅ Webhook handler reads `user_id` from metadata → updates tier to 'plus', credits to 150
6. ⚠️ User must close the checkout tab (shows 404 page) and re-open popup to see updated credits
7. ✅ Next popup open → `GET_USER_STATE` → shows new tier and credits

**Verdict: ⚠️ Might fail at step 6 (UX issue, not functional)**

### Flow 5: Monthly reset → credits reset

1. ✅ Stripe fires `invoice.paid` at the start of each billing cycle
2. ✅ Webhook handler finds user by `stripe_customer_id`
3. ✅ Sets `credits_remaining` to tier limit, updates `credits_reset_at`
4. ❌ **Free tier users never reset** — no `invoice.paid` fires for $0 subscriptions

**Verdict: ⚠️ Works for paid users, ❌ Broken for free users**

---

## Prioritized Action List

### CRITICAL (Blocks basic functionality)

1. **❌ Free tier monthly credit reset is broken**
   - Free users who exhaust 10 credits never get more.
   - No cron job or on-demand reset exists.
   - **Fix**: Add a check in `checkCredits()`: if `now() > credits_reset_at`, reset credits to `credits_monthly_limit` and advance `credits_reset_at` by 1 month. Or add a Cloudflare Cron Trigger.

### HIGH (Must fix before any public release)

2. **⚠️ Stripe checkout success/cancel URLs are 404s**
   - `success_url` and `cancel_url` point to Worker routes that don't exist.
   - User sees a broken page after paying.
   - **Fix**: Create a static success/cancel page, or redirect to a hosted page, or use `chrome-extension://` URL (complex).

3. **⚠️ Model ID duplicated in 3 places**
   - `claude.ts:36`, `analyse.ts:118`, `analyse.ts:151` all hardcode the Sonnet model string.
   - Easy to update one and miss the others (has already happened — hence the uncommitted fix).
   - **Fix**: Import `SONNET_MODEL` from `claude.ts` in `analyse.ts`.

4. **⚠️ Uncommitted model ID changes**
   - `analyse.ts` and `claude.ts` have uncommitted changes updating the Sonnet model ID.
   - The deployed Worker may still use the old model ID.
   - **Fix**: Commit and deploy.

5. **⚠️ Pro tier loses money**
   - At $0.03/analysis × 500 = $15/month API cost on a $9.99/month plan.
   - Must either raise price, reduce allocation, or use a cheaper model.

### MEDIUM (Should fix for quality)

6. **⚠️ CORS reflects any origin**
   - Low risk but should restrict to known origins for defense-in-depth.
   - **Fix**: Allowlist `chrome-extension://` and `https://woffle-api.andrewpaskin.workers.dev`.

7. **⚠️ No analyses table cleanup**
   - Old prompt version entries accumulate forever.
   - Not urgent but should add periodic cleanup (delete entries with non-current prompt_version older than 90 days).

8. **⚠️ addCredits() race condition on webhook double-fire**
   - `checkout.session.completed` or `invoice.paid` double-fire → duplicate `credit_transactions` entries.
   - Credit amounts are correct (absolute set in `updateUser`), just audit log duplicates.
   - **Fix**: Add idempotency key (Stripe event ID) to `credit_transactions` with UNIQUE constraint.

9. **⚠️ No max transcript length guard**
   - A 4-hour video transcript could be 50K+ tokens → $0.15+ per analysis.
   - **Fix**: Cap transcript at 60 minutes or 30K characters in the Worker.

10. **🔧 `addCredits()` is not atomic**
    - Read-then-write pattern: `getUser()` → `credits + amount` → `PATCH`.
    - For additive ops this is harmless (slight over-credit is fine).
    - Could use a Supabase RPC for correctness if desired.

### LOW (Nice to have)

11. **🗑️ `/api/channels` route is dead code**
    - Fully implemented but never called from the extension.
    - Keep if channel auto-analyse feature is coming soon, otherwise remove.

12. **🔧 SUPABASE_URL could be in `[vars]` instead of secrets**
    - It's public (visible in extension source). Putting it in vars makes `wrangler.toml` more self-documenting.

13. **🔧 No rate limiting on the Worker**
    - A malicious user with a valid JWT could spam `POST /api/analyse` (each deducts a credit, but the API calls still cost money).
    - Low priority — credits are the natural rate limit.

14. **🔧 Worker error responses don't use consistent structure**
    - Some return `{error: 'code'}`, some `{error: 'code', detail: '...'}`, some `{error: 'code', message: '...'}`.
    - Should standardise on one format.

---

## Viability Assessment

### Is this product ready to charge money for?

**No, not yet.** Three things must happen first:

1. **Fix free tier credit reset** (CRITICAL). Without this, every free user who tries Woffle and uses their 10 scans is permanently locked out. They'll never come back, and you lose the conversion opportunity. This is the single biggest blocker.

2. **Fix Stripe checkout success/cancel pages** (HIGH). A user who pays $4.99-$9.99 and sees a 404 page will panic, file chargebacks, and leave bad reviews. Even a simple "Payment received! You can close this tab." page solves it.

3. **Solve Pro tier economics** (HIGH). You cannot sell a $9.99/month plan that costs you $15/month in API calls. Options:
   - Reduce Pro to 200 analyses (still generous, cost: $6)
   - Raise Pro to $14.99 (cost: $15, but cache hits help)
   - Use Haiku for some analyses (cheaper, lower quality)
   - Implement a "smart" mode where popular/short videos use Haiku, long/unique videos use Sonnet

### What's genuinely good about this backend

- **The architecture is sound.** Two-pass analysis, SSE streaming, shared cache, atomic credit deduction — these are well-engineered for a solo dev project.
- **Security is solid.** Stripe webhook verification, JWT auth, RLS policies, no leaked secrets, SECURITY DEFINER RPCs — all the right patterns.
- **The caching strategy is smart.** Shared cache means popular videos are essentially free. Prompt versioning allows iteration without serving stale results.
- **The prompt is well-crafted.** v3.0 with topic anchoring, category taxonomy, and podcast rules is genuinely sophisticated.

### Bottom line

Fix the three blockers above, commit and deploy the model ID changes, and you have a commercially viable product. The architecture doesn't need rethinking — it's the small gaps (free reset, checkout UX, pricing math) that matter.
