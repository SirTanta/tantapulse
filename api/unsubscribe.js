/**
 * POST /api/unsubscribe
 *
 * Accepts an email address and records the opt-out in the
 * lead_feed_unsubscribes table. Returns 200 regardless of whether
 * the email was found, to prevent email enumeration.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.THOS_SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({ ok: true });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(200).json({ ok: true });
  }

  const normalisedEmail = email.trim().toLowerCase();

  // Record the opt-out — idempotent on email
  const insertRes = await fetch(
    `${supabaseUrl}/rest/v1/lead_feed_unsubscribes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        email: normalisedEmail,
        unsubscribed_at: new Date().toISOString(),
      }),
    }
  );

  if (!insertRes.ok) {
    console.error("[Unsubscribe] DB insert failed:", insertRes.status);
  }

  return res.status(200).json({ ok: true });
}
