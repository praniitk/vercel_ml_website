-- ════════════════════════════════════════════════════════════
--  ModelMatch — Supabase Schema
--  Run this entire file in: Supabase Dashboard → SQL Editor
-- ════════════════════════════════════════════════════════════

-- ── 1. ANALYSES TABLE ────────────────────────────────────────
--  Stores every analysis request (successful and failed).
--  No PII stored — IP is hashed, no full CSV rows.

CREATE TABLE IF NOT EXISTS public.analyses (
  id               BIGSERIAL PRIMARY KEY,
  ip_hash          TEXT,                          -- base64 hash of IP (not raw IP)
  file_name        TEXT,                          -- e.g. "titanic.csv"
  row_count        INTEGER,
  col_count        INTEGER,
  problem_type     TEXT,                          -- Classification | Regression | Clustering
  detected_subtype TEXT,                          -- binary | multiclass | regression
  target_col       TEXT,
  algo_families    TEXT[],                        -- array of family names selected
  family_count     INTEGER,
  best_model       TEXT,                          -- overallBestModel from Claude
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  total_tokens     INTEGER,
  error_msg        TEXT,                          -- null on success
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

-- ── 2. INDEXES ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_analyses_started  ON public.analyses (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_problem  ON public.analyses (problem_type);
CREATE INDEX IF NOT EXISTS idx_analyses_ip       ON public.analyses (ip_hash);

-- ── 3. ROW LEVEL SECURITY ────────────────────────────────────
--  Table is only accessible via service_role key (used in backend).
--  The anon key (used in any client) cannot read or write this table.

ALTER TABLE public.analyses ENABLE ROW LEVEL SECURITY;

-- No policies = anon/authenticated roles have zero access.
-- Only service_role bypasses RLS — which is what the backend uses.

-- ── 4. USAGE STATS VIEW ──────────────────────────────────────
--  Handy view for your Supabase dashboard to monitor usage.

CREATE OR REPLACE VIEW public.usage_stats AS
SELECT
  DATE_TRUNC('day', started_at)        AS day,
  COUNT(*)                             AS total_analyses,
  COUNT(*) FILTER (WHERE error_msg IS NULL)  AS successful,
  COUNT(*) FILTER (WHERE error_msg IS NOT NULL) AS failed,
  SUM(total_tokens)                    AS total_tokens_used,
  SUM(input_tokens)                    AS total_input_tokens,
  SUM(output_tokens)                   AS total_output_tokens,
  ROUND(AVG(total_tokens))             AS avg_tokens_per_call,
  ROUND(AVG(family_count), 1)          AS avg_families_selected,
  COUNT(DISTINCT ip_hash)              AS unique_ips
FROM public.analyses
GROUP BY 1
ORDER BY 1 DESC;

-- ── 5. POPULAR MODELS VIEW ───────────────────────────────────
CREATE OR REPLACE VIEW public.popular_models AS
SELECT
  best_model,
  problem_type,
  COUNT(*)  AS times_recommended
FROM public.analyses
WHERE best_model IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC
LIMIT 20;

-- ── 6. POPULAR FAMILIES VIEW ─────────────────────────────────
CREATE OR REPLACE VIEW public.popular_families AS
SELECT
  UNNEST(algo_families) AS family,
  COUNT(*)              AS times_selected
FROM public.analyses
WHERE algo_families IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;

-- ════════════════════════════════════════════════════════════
--  DONE. You should see:
--  • Table:  analyses
--  • Views:  usage_stats, popular_models, popular_families
-- ════════════════════════════════════════════════════════════
