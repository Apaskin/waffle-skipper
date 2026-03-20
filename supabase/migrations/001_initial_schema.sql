-- ============================================================
-- Woffle — Initial Schema
-- ============================================================
-- Three tables: users, analyses (shared cache), credit_transactions.
-- RLS ensures users only see their own data. The analyses table is
-- readable by all authenticated users (the whole point is shared cache).
-- Only the service role can write to analyses (via the CF Worker).
-- ============================================================

-- ============================================================
-- 1. Custom types
-- ============================================================

-- User subscription tier
CREATE TYPE user_tier AS ENUM ('free', 'plus', 'pro');

-- Credit transaction reasons — kept as an enum so typos don't sneak in
CREATE TYPE credit_reason AS ENUM (
  'monthly_reset',
  'analysis',
  'topup_purchase',
  'refund',
  'signup_bonus'
);

-- ============================================================
-- 2. Users table
-- ============================================================
-- Maps 1-to-1 with Supabase auth.users via id.
-- The trigger below auto-creates a row on signup.

CREATE TABLE IF NOT EXISTS users (
  id                    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                 text NOT NULL,
  tier                  user_tier NOT NULL DEFAULT 'free',
  credits_remaining     int NOT NULL DEFAULT 10,
  credits_monthly_limit int NOT NULL DEFAULT 10,
  credits_reset_at      timestamptz NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  stripe_customer_id    text,
  stripe_subscription_id text,
  auto_analyse_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Index for Stripe webhook lookups
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ============================================================
-- 3. Analyses table (shared cache)
-- ============================================================
-- One row per analysed video. The segments column holds the full
-- confidence-scored segment array from Claude. video_id is the
-- YouTube video ID (e.g. 'dQw4w9WgXcQ'), unique-indexed so
-- duplicate analyses are impossible.

CREATE TABLE IF NOT EXISTS analyses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id               text NOT NULL,
  video_title            text,
  video_duration_seconds int,
  segments               jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_used             text,
  prompt_version         text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  requested_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  access_count           int NOT NULL DEFAULT 1
);

-- Unique on video_id — the primary lookup. Only one analysis per video
-- (per prompt_version — see the WHERE clause on cache lookups in code).
CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_video_id ON analyses (video_id);

-- Composite index for cache-hit queries: video_id + prompt_version
CREATE INDEX IF NOT EXISTS idx_analyses_cache_lookup ON analyses (video_id, prompt_version);

-- ============================================================
-- 4. Credit transactions (audit log)
-- ============================================================
-- Every credit change is logged here: monthly resets, analysis
-- deductions, top-up purchases, refunds. This is append-only
-- and provides a full audit trail.

CREATE TABLE IF NOT EXISTS credit_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     int NOT NULL,
  reason     credit_reason NOT NULL,
  video_id   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions (user_id, created_at DESC);

-- ============================================================
-- 5. Row Level Security
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;

-- Users: can read own row only. Updates happen via the service role (worker).
CREATE POLICY "Users can read own record"
  ON users FOR SELECT
  USING (auth.uid() = id);

-- Analyses: readable by ALL authenticated users (shared cache).
-- Only the service role (via the CF Worker) can insert/update.
CREATE POLICY "Analyses are readable by all authenticated users"
  ON analyses FOR SELECT
  TO authenticated
  USING (true);

-- Credit transactions: users can read their own.
CREATE POLICY "Users can read own transactions"
  ON credit_transactions FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================
-- 6. Auto-create user row on Supabase auth signup
-- ============================================================
-- When a new user signs up via Supabase Auth, automatically
-- create their corresponding users row with free-tier defaults.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop first to avoid duplicate trigger errors on re-run
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- 7. updated_at trigger for users table
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON users;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
