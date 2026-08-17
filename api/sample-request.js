import { createHash } from "node:crypto";

const ALLOWED_ORIGINS = new Set([
  "https://tantapulse.com",
  "https://www.tantapulse.com",
  "http://localhost:3000",
  "http://localhost:3001",
]);

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function originAllowed(req) {
  const origin = req.headers.origin || req.headers.referer || "";
  if (!origin) return true;
  try {
    return ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizedRequest(body) {
  return {
    name: normalize(body.name),
    email: normalize(body.email).toLowerCase(),
    niche: normalize(body.niche),
    city: normalize(body.city),
    cadence: normalize(body.cadence || "weekly").toLowerCase(),
    notes: normalize(body.notes),
  };
}

function dedupeKey(request) {
  const canonical = JSON.stringify([
    request.name.toLowerCase(),
    request.email,
    request.niche.toLowerCase(),
    request.city.toLowerCase(),
    request.cadence,
    request.notes.toLowerCase(),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function crmConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY,
  };
}

async function persistIntake(request) {
  const { url, key } = crmConfig();
  if (!url || !key) throw new Error("crm configuration unavailable");

  const res = await fetch(`${url}/rest/v1/rpc/intake_sample_request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      p_name: request.name,
      p_email: request.email,
      p_niche: request.niche,
      p_city: request.city,
      p_cadence: request.cadence,
      p_notes: request.notes,
      p_dedupe_key: dedupeKey(request),
    }),
  });
  if (!res.ok) throw new Error("crm persistence rejected");

  const rows = await res.json().catch(() => null);
  const record = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!record
    || typeof record.receipt_id !== "string"
    || typeof record.status !== "string"
    || record.owner !== "sakuya"
    || typeof record.sla_due_at !== "string"
    || typeof record.duplicate !== "boolean") {
    throw new Error("crm persistence was not confirmed");
  }
  return record;
}

export default async function handler(req, res) {
  if (!originAllowed(req)) return res.status(403).json({ error: "Forbidden" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const request = normalizedRequest(body);
  if (!request.name || !request.email || !request.niche || !request.city || !isEmail(request.email)) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const record = await persistIntake(request);
    return res.status(200).json({
      ok: true,
      receipt_id: record.receipt_id,
      status: record.status,
      owner: record.owner,
      sla_due_at: record.sla_due_at,
      duplicate: record.duplicate,
    });
  } catch {
    return res.status(503).json({ error: "Unable to process request" });
  }
}
