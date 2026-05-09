/**
 * api/analyze.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────
 * • Receives dataset profile from frontend
 * • Makes ONE optimized Claude API call for ALL algorithm families
 * • Logs every analysis to Supabase (analyses table)
 * • Returns structured JSON recommendations + token usage
 *
 * Env vars needed in Vercel dashboard:
 *   ANTHROPIC_API_KEY      — your Claude API key
 *   SUPABASE_URL           — from Supabase project settings
 *   SUPABASE_SERVICE_KEY   — service_role key (not anon key)
 */

const Anthropic          = require('@anthropic-ai/sdk');
const { createClient }   = require('@supabase/supabase-js');

// ── Rate limiting (in-memory, resets per cold start) ──────────────
// For production scale, replace with Upstash Redis + @upstash/ratelimit
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 25;           // requests per minute per IP
const ipMap          = new Map();

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = ipMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW_MS) { entry.count = 0; entry.start = now; }
  entry.count++;
  ipMap.set(ip, entry);
  return entry.count > RATE_MAX;
}

// ── Clients (initialised once per warm instance) ──────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Main handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  // ── Destructure & validate body ───────────────────────────────
  const {
    fileName, rowCount, headers, colTypes, colUnique,
    sampleRows, targetCol, detectedSubtype,
    problemType, selectedAlgos,
  } = req.body || {};

  if (!Array.isArray(headers) || !headers.length)
    return res.status(400).json({ error: 'Missing: headers array.' });
  if (!problemType || !['Classification','Regression','Clustering'].includes(problemType))
    return res.status(400).json({ error: 'Invalid problemType.' });
  if (!Array.isArray(selectedAlgos) || !selectedAlgos.length)
    return res.status(400).json({ error: 'Missing: selectedAlgos array.' });
  if (selectedAlgos.length > 12)
    return res.status(400).json({ error: 'Maximum 12 algorithm families per request.' });

  // ── Build lean dataset profile string ─────────────────────────
  const numericCols   = headers.filter(h => colTypes?.[h] === 'num');
  const categoricCols = headers.filter(h => colTypes?.[h] === 'cat');

  const colSummary = headers
    .map(h => `${h}[${colTypes?.[h]==='num'?'N':'C'},${colUnique?.[h]??'?'}u]`)
    .join(' | ');

  const sampleStr = (Array.isArray(sampleRows) ? sampleRows : [])
    .slice(0, 6)
    .map(r => (Array.isArray(r) ? r : []).join(', '))
    .join('\n');

  // ── THE ONE OPTIMIZED PROMPT ───────────────────────────────────
  // All algorithm families packed into a single Claude call.
  // System prompt keeps Claude focused and output structured.

  const SYSTEM = `You are ModelMatch, an expert ML model selection AI.
You always respond with a single valid JSON object — no markdown, no prose, no backticks.
Evaluate ALL requested algorithm families together in one response.
Make every recommendation specific to the actual dataset profile provided (row count, column types, cardinalities, target distribution).
Feature importance values must cover every column and sum to exactly 1.00.`;

  const USER = `=== DATASET PROFILE ===
File          : ${fileName ?? 'dataset.csv'}
Rows          : ${rowCount ?? '?'}
Total columns : ${headers.length}
Numeric cols  : ${numericCols.length} → ${numericCols.join(', ') || 'none'}
Categorical   : ${categoricCols.length} → ${categoricCols.join(', ') || 'none'}
Column detail : ${colSummary}
Target (Y)    : "${targetCol}" | subtype: ${detectedSubtype ?? 'unspecified'} | unique values: ${colUnique?.[targetCol] ?? '?'}
Problem type  : ${problemType}
Families      : ${selectedAlgos.join(' | ')}

=== SAMPLE ROWS (first 6) ===
${sampleStr || '(none provided)'}

=== REQUIRED JSON STRUCTURE ===
Return exactly this shape — one entry per family listed above:
{
  "classificationNote": "<binary vs multiclass implications, or null>",
  "recommendations": [
    {
      "family": "<family name>",
      "bestModel": "<specific sklearn/library class name>",
      "whyShort": "<2 sentences tailored to THIS dataset>",
      "metrics": ["<metric1>","<metric2>","<metric3>"],
      "complexity": "Low|Medium|High",
      "interpretability": "Low|Medium|High",
      "hyperparams": ["<param=range>","<param=range>","<param=range>"],
      "pros": ["<pro1>","<pro2>"],
      "cons": ["<con1>"]
    }
  ],
  "featureImportance": [
    { "feature": "<exact column name>", "importance": 0.00, "reason": "<one line>" }
  ],
  "datasetInsights": {
    "overallBestModel": "<best model name>",
    "overallBestFamily": "<its family>",
    "overallReason": "<one sentence>",
    "dataSize": "small|medium|large",
    "dataCharacteristics": ["<insight1>","<insight2>","<insight3>"],
    "preprocessingTips": ["<tip1>","<tip2>","<tip3>"]
  }
}`;

  const startedAt = new Date().toISOString();
  let claudeResult = null;
  let usage        = null;

  try {
    // ── Single Claude API call ─────────────────────────────────
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: USER }],
    });

    const raw = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    claudeResult = JSON.parse(raw.replace(/```json|```/g, '').trim());
    usage = {
      inputTokens:  message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      totalTokens:  message.usage.input_tokens + message.usage.output_tokens,
    };

    // ── Log to Supabase (non-blocking) ────────────────────────
    // If Supabase insert fails, we still return results to user
    supabase.from('analyses').insert({
      ip_hash:          Buffer.from(ip).toString('base64').slice(0, 20),
      file_name:        fileName ?? null,
      row_count:        rowCount ?? null,
      col_count:        headers.length,
      problem_type:     problemType,
      detected_subtype: detectedSubtype ?? null,
      target_col:       targetCol ?? null,
      algo_families:    selectedAlgos,
      family_count:     selectedAlgos.length,
      best_model:       claudeResult?.datasetInsights?.overallBestModel ?? null,
      input_tokens:     usage.inputTokens,
      output_tokens:    usage.outputTokens,
      total_tokens:     usage.totalTokens,
      started_at:       startedAt,
      completed_at:     new Date().toISOString(),
    }).then(({ error }) => {
      if (error) console.warn('[supabase] Insert error:', error.message);
    });

    // ── Return to frontend ─────────────────────────────────────
    return res.status(200).json({ ok: true, result: claudeResult, usage });

  } catch (err) {
    console.error('[analyze] Error:', err.message);

    // Log failed attempt too
    supabase.from('analyses').insert({
      ip_hash:      Buffer.from(ip).toString('base64').slice(0, 20),
      file_name:    fileName ?? null,
      problem_type: problemType,
      algo_families: selectedAlgos,
      family_count: selectedAlgos.length,
      error_msg:    err.message,
      started_at:   startedAt,
      completed_at: new Date().toISOString(),
    }).then(() => {});

    if (err instanceof SyntaxError)
      return res.status(502).json({ error: 'Claude returned malformed JSON. Please retry.' });
    if (err.status === 429)
      return res.status(429).json({ error: 'Claude API rate limit reached. Please wait and retry.' });
    if (err.status === 401)
      return res.status(500).json({ error: 'Invalid API key. Check Vercel environment variables.' });

    return res.status(500).json({ error: 'Analysis failed. Please try again.', detail: err.message });
  }
};
