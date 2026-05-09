# ModelMatch — Complete Deployment Guide
## Vercel (frontend + API) + Supabase (database)

---

## Final folder structure

```
modelmatch-vercel/
├── vercel.json              ← Tells Vercel how to route requests
├── package.json             ← Dependencies for the serverless function
├── frontend/
│   └── index.html           ← Complete frontend (single file)
├── api/
│   └── analyze.js           ← Serverless function (ONE Claude call)
└── supabase/
    └── schema.sql            ← Run once in Supabase SQL editor
```

---

## PHASE 1 — SUPABASE SETUP (5 minutes)

### 1.1  Create the database table

1. Go to https://supabase.com and sign in
2. Open your project (or create a new one — free tier is fine)
3. In the left sidebar click **SQL Editor**
4. Click **New query**
5. Copy the entire contents of `supabase/schema.sql` and paste it
6. Click **Run** (green button, top right)
7. You should see: "Success. No rows returned."

This creates:
- `analyses` table — stores every request (no raw user data)
- `usage_stats` view — daily token/request stats
- `popular_models` view — which models get recommended most
- `popular_families` view — which algorithm families are selected most

### 1.2  Get your Supabase credentials

1. In the left sidebar go to **Project Settings → API**
2. Copy these two values (you'll need them in Phase 3):

```
SUPABASE_URL        = https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  (service_role key, NOT anon key)
```

⚠️  Use the **service_role** key (under "Service role" section), NOT the anon/public key.
    The service_role key bypasses Row Level Security — only safe to use server-side.

---

## PHASE 2 — PUSH TO GITHUB (3 minutes)

Vercel deploys directly from GitHub. You need a repo.

```bash
# In your terminal, inside the modelmatch-vercel/ folder:

git init
git add .
git commit -m "Initial ModelMatch deployment"

# Create a new repo on github.com (name it: modelmatch)
# Then connect and push:
git remote add origin https://github.com/YOUR_USERNAME/modelmatch.git
git branch -M main
git push -u origin main
```

---

## PHASE 3 — VERCEL DEPLOYMENT (5 minutes)

### 3.1  Import the project

1. Go to https://vercel.com and sign in (use GitHub login)
2. Click **Add New → Project**
3. Find your `modelmatch` repo and click **Import**

### 3.2  Configure build settings

In the configuration screen:

| Setting | Value |
|---------|-------|
| Framework Preset | **Other** |
| Root Directory | `.` (leave as default) |
| Build Command | *(leave blank)* |
| Output Directory | `frontend` |
| Install Command | `npm install` |

### 3.3  Add environment variables

Before clicking Deploy, scroll down to **Environment Variables** and add these three:

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-YOUR-NEW-KEY-HERE` |
| `SUPABASE_URL` | `https://xxxxxxxxxxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJhbGciOi...` (service_role key) |

### 3.4  Deploy

Click **Deploy**. Vercel will:
1. Install npm dependencies (`@anthropic-ai/sdk`, `@supabase/supabase-js`)
2. Detect `api/analyze.js` as a serverless function
3. Serve `frontend/` as static files
4. Route `/api/*` to the serverless function, everything else to the frontend

### 3.5  Your site is live

Vercel gives you a URL like: `https://modelmatch-abc123.vercel.app`

Test it:
- Open the URL in your browser → you should see the ModelMatch homepage
- Upload a CSV → go through the steps → click Analyze
- Check Supabase → Table Editor → `analyses` table → you should see a new row

---

## PHASE 4 — CUSTOM DOMAIN (optional, 5 minutes)

1. In Vercel dashboard → your project → **Settings → Domains**
2. Click **Add Domain**
3. Enter your domain (e.g. `modelmatch.yourdomain.com`)
4. Add the DNS records Vercel shows you (CNAME or A record) in your domain registrar
5. Vercel auto-provisions SSL — done

---

## PHASE 5 — VERIFY EVERYTHING WORKS

### 5.1  Test the API directly

```bash
curl -X POST https://modelmatch-abc123.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "test.csv",
    "rowCount": 500,
    "headers": ["age","income","defaulted"],
    "colTypes": {"age":"num","income":"num","defaulted":"cat"},
    "colUnique": {"age":45,"income":480,"defaulted":2},
    "sampleRows": [["28","52000","0"],["45","88000","1"]],
    "targetCol": "defaulted",
    "detectedSubtype": "binary",
    "problemType": "Classification",
    "selectedAlgos": ["Gradient boosting","Ensemble methods","Linear models"]
  }'
```

You should get back a JSON with `"ok": true` and full recommendations.

### 5.2  Check Supabase logging

1. Supabase dashboard → Table Editor → `analyses`
2. You should see a row with the test request data

### 5.3  Check usage stats

1. Supabase dashboard → Table Editor → `usage_stats` (it's a view)
2. You'll see today's date with token counts and request counts

---

## HOW THE ROUTING WORKS ON VERCEL

```
User visits  https://your-site.vercel.app/
             ↓
  vercel.json routes "/" → frontend/index.html  (static HTML)

User's browser POSTs to  https://your-site.vercel.app/api/analyze
             ↓
  vercel.json routes "/api/*" → api/analyze.js  (serverless function)
             ↓
  analyze.js calls Anthropic API (ONE call, all families)
             ↓
  analyze.js logs to Supabase (non-blocking)
             ↓
  Returns JSON to frontend
```

No separate server. No separate domain. No CORS issues.
Everything runs on Vercel's edge infrastructure — global, fast, auto-scaling.

---

## COST ESTIMATE

### Vercel (free tier covers this easily)
- Serverless function invocations: 100,000/month free
- Bandwidth: 100GB/month free
- Cost at 1,000 users/month: $0

### Supabase (free tier covers this)
- Database: 500MB free
- API requests: unlimited on free tier
- Cost at 1,000 users/month: $0

### Anthropic Claude API
- Model: claude-sonnet-4-20250514
- ~2,000 tokens per analysis (input + output combined)
- Pricing: ~$3/M input tokens, ~$15/M output tokens
- Blended cost: ~$0.004–0.006 per analysis
- Cost at 1,000 analyses/month: ~$4–6/month

---

## MONITORING YOUR USAGE

Run these queries in Supabase SQL Editor anytime:

```sql
-- Daily usage summary
SELECT * FROM usage_stats ORDER BY day DESC LIMIT 7;

-- Most recommended models
SELECT * FROM popular_models LIMIT 10;

-- Most selected algorithm families
SELECT * FROM popular_families LIMIT 10;

-- Today's analyses
SELECT file_name, problem_type, best_model, total_tokens, completed_at
FROM analyses
WHERE started_at > NOW() - INTERVAL '24 hours'
ORDER BY started_at DESC;

-- Total spend estimate (approximate)
SELECT
  SUM(input_tokens) * 0.000003  AS input_cost_usd,
  SUM(output_tokens) * 0.000015 AS output_cost_usd,
  SUM(input_tokens) * 0.000003 + SUM(output_tokens) * 0.000015 AS total_cost_usd
FROM analyses
WHERE error_msg IS NULL;
```

---

## UPDATING THE SITE

Any push to the `main` branch on GitHub triggers an automatic Vercel redeploy.

```bash
# Make a change to any file, then:
git add .
git commit -m "Update: ..."
git push

# Vercel redeploys in ~30 seconds
```

---

## RATE LIMITING NOTES

The current rate limiter in `api/analyze.js` is in-memory (resets on cold start).
For production at scale, replace it with Upstash Redis:

```bash
npm install @upstash/ratelimit @upstash/redis
```

Add to Vercel env vars:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Upstash free tier: 10,000 requests/day — more than enough to start.

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| "Analysis failed" on frontend | Check Vercel function logs: Vercel dashboard → project → Deployments → Functions tab |
| Supabase rows not appearing | Check `SUPABASE_SERVICE_KEY` is the service_role key, not anon |
| 500 error from API | Verify `ANTHROPIC_API_KEY` is set in Vercel env vars (not just local .env) |
| CORS error | Shouldn't happen since frontend and API share the same Vercel domain |
| PDF not downloading | jsPDF loads from cdnjs CDN — check user's network/adblocker |
