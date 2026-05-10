/**
 * api/analyze.js  —  Vercel Serverless Function (Node 20)
 *
 * Fix: Replaced @supabase/supabase-js with a direct fetch()
 * call to the Supabase REST API. This avoids the WebSocket /
 * Realtime init error that crashes Node 20 serverless functions.
 *
 * Required Vercel Environment Variables:
 *   ANTHROPIC_API_KEY     — your Claude API key
 *   SUPABASE_URL          — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  — service_role key (not anon)
 */

const Anthropic = require("@anthropic-ai/sdk");

/* ── Anthropic client ────────────────────────────────────────── */
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[startup] MISSING: ANTHROPIC_API_KEY is not set.");
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ── Supabase: plain fetch() to REST API — no SDK needed ─────── */
// This avoids the WebSocket crash entirely.
async function logToSupabase(row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return; // silently skip if not configured

  try {
    await fetch(`${url}/rest/v1/analyses`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        key,
        "Authorization": `Bearer ${key}`,
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.warn("[supabase] log failed:", e.message);
  }
}

/* ── In-memory rate limiter ──────────────────────────────────── */
const RATE_WINDOW = 60_000;
const RATE_MAX    = 20;
const ipMap       = new Map();

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = ipMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) { entry.count = 0; entry.start = now; }
  entry.count++;
  ipMap.set(ip, entry);
  return entry.count > RATE_MAX;
}

/* ── Main handler ────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  /* CORS */
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed." });

  /* Rate limit */
  const ip = (req.headers["x-forwarded-for"] || "unknown")
    .split(",")[0].trim();
  if (isRateLimited(ip))
    return res.status(429).json({ error: "Too many requests — please wait a minute." });

  /* Destructure + validate */
  const {
    fileName, rowCount, headers, colTypes, colUnique,
    sampleRows, targetCol, detectedSubtype,
    problemType, selectedAlgos,
  } = req.body || {};

  if (!Array.isArray(headers) || headers.length === 0)
    return res.status(400).json({ error: "Missing: headers array." });
  if (!["Classification","Regression","Clustering"].includes(problemType))
    return res.status(400).json({ error: "Invalid problemType." });
  if (!Array.isArray(selectedAlgos) || selectedAlgos.length === 0)
    return res.status(400).json({ error: "Missing: selectedAlgos array." });
  if (selectedAlgos.length > 12)
    return res.status(400).json({ error: "Max 12 algorithm families per request." });

  /* Build dataset profile for prompt */
  const numericCols  = headers.filter(h => colTypes?.[h] === "num");
  const categoricCols= headers.filter(h => colTypes?.[h] === "cat");
  const colSummary   = headers
    .map(h => `${h}[${colTypes?.[h]==="num"?"N":"C"},${colUnique?.[h]??"?"}u]`)
    .join(" | ");
  const sampleStr    = (Array.isArray(sampleRows) ? sampleRows : [])
    .slice(0, 6)
    .map(r => (Array.isArray(r) ? r : []).join(", "))
    .join("\n");

  /* ── SINGLE OPTIMIZED CLAUDE PROMPT ──────────────────────────
     All families in one call — no per-family loops, no extra cost.
  ─────────────────────────────────────────────────────────── */
  const SYSTEM = `You are ModelMatch, an expert ML model selection AI.
Respond with ONE valid JSON object only.
No markdown, no backticks, no explanation before or after the JSON.
Evaluate ALL requested algorithm families in this single response.
Tailor every recommendation to the actual dataset profile provided.
Feature importance values must cover every column and sum to exactly 1.00.`;

  const USER = `=== DATASET PROFILE ===
File          : ${fileName ?? "dataset.csv"}
Rows          : ${rowCount ?? "?"}
Total columns : ${headers.length}
Numeric cols  : ${numericCols.length} → ${numericCols.join(", ") || "none"}
Categorical   : ${categoricCols.length} → ${categoricCols.join(", ") || "none"}
Column detail : ${colSummary}
Target (Y)    : "${targetCol}" | subtype: ${detectedSubtype ?? "unspecified"} | unique values: ${colUnique?.[targetCol] ?? "?"}
Problem type  : ${problemType}
Evaluate ALL of these families: ${selectedAlgos.join(" | ")}

=== SAMPLE ROWS (first 6) ===
${sampleStr || "(none provided)"}

=== RETURN THIS EXACT JSON SHAPE ===
{
  "classificationNote": "<string or null>",
  "recommendations": [
    {
      "family": "<family name>",
      "bestModel": "<specific model class name>",
      "whyShort": "<2 sentences specific to THIS dataset>",
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
  console.log(`[analyze] ${ip} — ${problemType} — ${selectedAlgos.length} families — ${rowCount} rows`);

  try {
    /* ── One Claude API call ─────────────────────────────────── */
    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system:     SYSTEM,
      messages:   [{ role: "user", content: USER }],
    });

    console.log(`[analyze] Claude OK — in:${message.usage.input_tokens} out:${message.usage.output_tokens} tokens`);

    const raw = message.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    let result;
    try {
      result = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (parseErr) {
      console.error("[analyze] JSON parse failed. Raw:", raw.slice(0, 400));
      return res.status(502).json({ error: "Claude returned malformed JSON. Please retry." });
    }

    const usage = {
      inputTokens:  message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      totalTokens:  message.usage.input_tokens + message.usage.output_tokens,
    };

    /* Log to Supabase — non-blocking, fire and forget */
    logToSupabase({
      ip_hash:          Buffer.from(ip).toString("base64").slice(0, 20),
      file_name:        fileName ?? null,
      row_count:        rowCount ?? null,
      col_count:        headers.length,
      problem_type:     problemType,
      detected_subtype: detectedSubtype ?? null,
      target_col:       targetCol ?? null,
      algo_families:    selectedAlgos,
      family_count:     selectedAlgos.length,
      best_model:       result?.datasetInsights?.overallBestModel ?? null,
      input_tokens:     usage.inputTokens,
      output_tokens:    usage.outputTokens,
      total_tokens:     usage.totalTokens,
      started_at:       startedAt,
      completed_at:     new Date().toISOString(),
    });

    console.log(`[analyze] Done — best: ${result?.datasetInsights?.overallBestModel}`);
    return res.status(200).json({ ok: true, result, usage });

  } catch (err) {
    console.error("[analyze] Error:", err.status ?? "?", err.message);

    logToSupabase({
      ip_hash:       Buffer.from(ip).toString("base64").slice(0, 20),
      file_name:     fileName ?? null,
      problem_type:  problemType,
      algo_families: selectedAlgos,
      family_count:  selectedAlgos.length,
      error_msg:     err.message,
      started_at:    startedAt,
      completed_at:  new Date().toISOString(),
    });

    if (err.status === 429)
      return res.status(429).json({ error: "Claude API rate limit hit. Please retry in a moment." });
    if (err.status === 401)
      return res.status(500).json({ error: "Invalid API key — check ANTHROPIC_API_KEY in Vercel environment variables." });
    if (err.status === 400)
      return res.status(400).json({ error: "Bad request to Claude: " + err.message });

    return res.status(500).json({
      error:  "Analysis failed. Please try again.",
      detail: err.message,
    });
  }
};
