/**
 * api/analyze.js
 * Vercel Serverless Function — Node 20
 * ONE Claude API call covers all selected algorithm families.
 * Logs every request to Supabase (non-blocking).
 *
 * Required Vercel Environment Variables:
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const Anthropic        = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

/* ── Clients (reused across warm invocations) ──────────────── */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ── Simple in-memory rate limiter (per cold-start instance) ── */
const RATE_WINDOW = 60_000; // 1 minute
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

/* ── Main handler ──────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  /* CORS */
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  /* Rate limit */
  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests — please wait a minute and try again." });
  }

  /* Destructure body */
  const {
    fileName, rowCount, headers, colTypes, colUnique,
    sampleRows, targetCol, detectedSubtype,
    problemType, selectedAlgos,
  } = req.body || {};

  /* Validate */
  if (!Array.isArray(headers) || headers.length === 0)
    return res.status(400).json({ error: "Missing: headers array." });
  if (!["Classification","Regression","Clustering"].includes(problemType))
    return res.status(400).json({ error: "Invalid problemType." });
  if (!Array.isArray(selectedAlgos) || selectedAlgos.length === 0)
    return res.status(400).json({ error: "Missing: selectedAlgos array." });
  if (selectedAlgos.length > 12)
    return res.status(400).json({ error: "Max 12 algorithm families per request." });

  /* Build dataset profile string */
  const numericCols  = headers.filter(h => colTypes?.[h] === "num");
  const categoricCols= headers.filter(h => colTypes?.[h] === "cat");
  const colSummary   = headers
    .map(h => `${h}[${colTypes?.[h]==="num"?"N":"C"},${colUnique?.[h]??"?"}u]`)
    .join(" | ");
  const sampleStr = (Array.isArray(sampleRows) ? sampleRows : [])
    .slice(0, 6)
    .map(r => (Array.isArray(r) ? r : []).join(", "))
    .join("\n");

  /* ── THE ONE PROMPT — all families in a single call ───────── */
  const SYSTEM = `You are ModelMatch, an expert ML model selection AI.
You always respond with ONE valid JSON object only — no markdown, no backticks, no prose before or after.
Evaluate ALL requested algorithm families together in this single response.
Tailor every recommendation to the actual dataset profile (row count, column types, cardinalities, target distribution).
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
  "classificationNote": "<string or null — binary vs multiclass implications>",
  "recommendations": [
    {
      "family": "<family name>",
      "bestModel": "<specific sklearn/library model class name>",
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
    "overallBestModel": "<best model name across all families>",
    "overallBestFamily": "<its family name>",
    "overallReason": "<one sentence>",
    "dataSize": "small|medium|large",
    "dataCharacteristics": ["<insight1>","<insight2>","<insight3>"],
    "preprocessingTips": ["<tip1>","<tip2>","<tip3>"]
  }
}`;

  const startedAt = new Date().toISOString();

  try {
    /* ── Single Claude API call ─────────────────────────────── */
    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system:     SYSTEM,
      messages:   [{ role: "user", content: USER }],
    });

    const raw  = message.content.filter(b => b.type === "text").map(b => b.text).join("");
    const result = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const usage = {
      inputTokens:  message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      totalTokens:  message.usage.input_tokens + message.usage.output_tokens,
    };

    /* ── Log to Supabase (non-blocking) ─────────────────────── */
    supabase.from("analyses").insert({
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
    }).then(({ error }) => {
      if (error) console.warn("[supabase] insert error:", error.message);
    });

    return res.status(200).json({ ok: true, result, usage });

  } catch (err) {
    console.error("[analyze] error:", err.message);

    supabase.from("analyses").insert({
      ip_hash:      Buffer.from(ip).toString("base64").slice(0, 20),
      file_name:    fileName ?? null,
      problem_type: problemType,
      algo_families: selectedAlgos,
      family_count: selectedAlgos.length,
      error_msg:    err.message,
      started_at:   startedAt,
      completed_at: new Date().toISOString(),
    }).then(() => {});

    if (err instanceof SyntaxError)
      return res.status(502).json({ error: "Claude returned malformed JSON. Please retry." });
    if (err.status === 429)
      return res.status(429).json({ error: "Claude API rate limit reached. Please retry in a moment." });
    if (err.status === 401)
      return res.status(500).json({ error: "Invalid Anthropic API key. Check Vercel environment variables." });

    return res.status(500).json({ error: "Analysis failed. Please try again.", detail: err.message });
  }
};
