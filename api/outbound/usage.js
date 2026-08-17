import { hunterGet } from "../../lib/outbound-lifecycle.mjs";

function authorized(req) {
  return Boolean(process.env.CRON_SECRET) && req.headers?.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });

  const apiKey = process.env.HUNTER_IO_API_KEY || process.env.HUNTER_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: true, mode: "disabled", blocked_by: ["HUNTER_IO_API_KEY"] });

  try {
    const [account, capacities] = await Promise.all([
      hunterGet({ path: "/account", apiKey }),
      hunterGet({ path: "/email-accounts/capacities", apiKey }),
    ]);
    const requests = account.data?.requests ?? {};
    const senderId = String(process.env.TANTAPULSE_HUNTER_SENDER_ACCOUNT_ID ?? "");
    const senders = Array.isArray(capacities.data) ? capacities.data : [];
    const sender = senders.find((item) => String(item.id) === senderId) ?? null;
    return res.status(200).json({
      ok: true,
      mode: "read_only",
      reset_date: account.data?.reset_date ?? null,
      credits: {
        discovery_remaining: number(requests.credits?.remaining ?? requests.credits?.available),
        verification_remaining: number(requests.verifications?.available) - number(requests.verifications?.used),
      },
      sender: sender ? {
        id: String(sender.id),
        sent_today: number(sender.sent),
        scheduled: number(sender.scheduled),
        daily_limit: number(sender.daily_limit),
        available_today: Math.max(0, number(sender.daily_limit) - number(sender.sent) - number(sender.scheduled)),
      } : null,
    });
  } catch {
    return res.status(502).json({ ok: false, error: "hunter_usage_read_failed" });
  }
}
