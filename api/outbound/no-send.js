import { makeNoSendReceipt } from "../../lib/outbound-lifecycle.mjs";

function authorized(req) {
  return Boolean(process.env.CRON_SECRET) && req.headers?.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const fixtures = Array.isArray(body.fixtures) ? body.fixtures : [];
  return res.status(200).json({ ok: true, receipt: makeNoSendReceipt({ campaignId: body.campaign_id, fixtures }) });
}
