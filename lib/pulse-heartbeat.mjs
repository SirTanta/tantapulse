/**
 * Shared heartbeat helper for TantaPulse's scheduled jobs.
 *
 * Every cron/job in the pipeline (discovery trigger/process, lead-feed bridge,
 * outreach fulfillment, reply-check) calls recordHeartbeat() once per
 * invocation, success or failure. This is the only durable, queryable signal
 * that a given job actually ran -- the Vercel cron schedule entry existing in
 * vercel.json tells you nothing about whether the job is firing or silently
 * 404ing/erroring (the discovery scraper did exactly this for 3 months,
 * unnoticed, before this was built 2026-10-03).
 *
 * thos-auto's pulse-health-check.py cron and the Atlas TantaPulse dashboard
 * both read public.pulse_job_heartbeats directly -- this helper is the only
 * writer. Best-effort: a heartbeat write failure is logged and swallowed, and
 * never allowed to fail the job it's instrumenting.
 */

function pulseDb() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.THOS_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.THOS_SUPABASE_SERVICE_KEY;
  return { url, key, ok: Boolean(url && key) };
}

/**
 * @param {string} jobName - stable key, e.g. "sales_discovery_trigger"
 * @param {boolean} ok - whether this invocation completed without error
 * @param {object} [detail] - small JSON-serializable summary (counts, reason, etc.)
 */
export async function recordHeartbeat(jobName, ok, detail = {}) {
  const { url, key, ok: configured } = pulseDb();
  if (!configured) return false;
  const now = new Date().toISOString();
  try {
    const res = await fetch(
      `${url}/rest/v1/pulse_job_heartbeats?on_conflict=job_name`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify([
          {
            job_name: jobName,
            last_run_at: now,
            last_ok: Boolean(ok),
            detail,
            updated_at: now,
          },
        ]),
      },
    );
    if (!res.ok) {
      console.error(
        `[pulse-heartbeat] ${jobName} write failed: ${res.status} ${await res.text()}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[pulse-heartbeat] ${jobName} write threw: ${err.message}`);
    return false;
  }
}
