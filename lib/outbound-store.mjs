function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}

async function request(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`outbound store request failed: ${response.status}`);
  return json;
}

export function createOutboundStore({ supabaseUrl, supabaseKey, fetchImpl = fetch }) {
  const base = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const auth = headers(supabaseKey);
  return {
    async getApproval(approvalId) {
      const rows = await request(fetchImpl, `${base}/tantapulse_campaign_approvals?id=eq.${encodeURIComponent(approvalId)}&select=*`, { headers: auth });
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async listAdmittedProspects(approvalId, ids) {
      if (!ids.length) return new Set();
      const safeIds = ids.map((id) => `"${String(id).replaceAll('"', '\\"')}"`).join(",");
      const rows = await request(fetchImpl, `${base}/tantapulse_prospect_state?approval_id=eq.${encodeURIComponent(approvalId)}&hunter_prospect_id=in.(${encodeURIComponent(safeIds)})&suppressed_at=is.null&select=hunter_prospect_id`, { headers: auth });
      return new Set(Array.isArray(rows) ? rows.map((row) => String(row.hunter_prospect_id)) : []);
    },
    async countAdmittedProspects(approvalId) {
      const rows = await request(fetchImpl, `${base}/tantapulse_prospect_state?approval_id=eq.${encodeURIComponent(approvalId)}&select=id&limit=1000`, { headers: auth });
      return Array.isArray(rows) ? rows.length : 0;
    },
    async listUnenrolledProspects(approvalId, limit = 50) {
      const rows = await request(fetchImpl, `${base}/tantapulse_prospect_state?approval_id=eq.${encodeURIComponent(approvalId)}&suppressed_at=is.null&hunter_enrolled_at=is.null&select=hunter_prospect_id,email&order=created_at.asc&limit=${Math.min(Math.max(Number(limit) || 50, 1), 50)}`, { headers: auth });
      return Array.isArray(rows) ? rows : [];
    },
    async markProspectsEnrolled(approvalId, prospectIds) {
      if (!prospectIds.length) return;
      const safeIds = prospectIds.map((id) => `"${String(id).replaceAll('"', '\\"')}"`).join(",");
      await request(fetchImpl, `${base}/tantapulse_prospect_state?approval_id=eq.${encodeURIComponent(approvalId)}&hunter_prospect_id=in.(${encodeURIComponent(safeIds)})`, {
        method: "PATCH",
        headers: headers(supabaseKey, { Prefer: "return=minimal" }),
        body: JSON.stringify({ hunter_enrolled_at: new Date().toISOString() }),
      });
    },
    async claimEvent({ approvalId, eventKey, event }) {
      const rows = await request(fetchImpl, `${base}/tantapulse_outbound_event_ledger?on_conflict=event_key`, {
        method: "POST",
        headers: headers(supabaseKey, { Prefer: "resolution=ignore-duplicates,return=representation" }),
        body: JSON.stringify([{ approval_id: approvalId, event_key: eventKey, crm_event_id: event.event_id, payload: event, status: "pending" }]),
      });
      return { claimed: Array.isArray(rows) && rows.length === 1, row: Array.isArray(rows) ? rows[0] || null : null };
    },
    async getEvent(eventKey) {
      const rows = await request(fetchImpl, `${base}/tantapulse_outbound_event_ledger?event_key=eq.${encodeURIComponent(eventKey)}&select=status,atlas_status`, { headers: auth });
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async admitProspect({ approvalId, prospect }) {
      await request(fetchImpl, `${base}/tantapulse_prospect_state?on_conflict=approval_id,hunter_prospect_id`, {
        method: "POST",
        headers: headers(supabaseKey, { Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify([{
          approval_id: approvalId,
          hunter_prospect_id: prospect.event.prospect_id,
          verification_status: "valid",
          email: prospect.event.prospect.email,
          crm_lead_created_at: new Date().toISOString(),
        }]),
      });
    },
    async completeEvent(eventKey, delivery) {
      await request(fetchImpl, `${base}/tantapulse_outbound_event_ledger?event_key=eq.${encodeURIComponent(eventKey)}`, {
        method: "PATCH",
        headers: headers(supabaseKey, { Prefer: "return=minimal" }),
        body: JSON.stringify({ status: delivery.ok ? "delivered" : "failed", atlas_status: delivery.status, last_error: delivery.ok ? null : delivery.error || "atlas_delivery_failed", delivered_at: delivery.ok ? new Date().toISOString() : null }),
      });
    },
    async recordReceipt(receipt) {
      await request(fetchImpl, `${base}/tantapulse_outbound_receipts`, {
        method: "POST",
        headers: headers(supabaseKey, { Prefer: "return=minimal" }),
        body: JSON.stringify([receipt]),
      });
    },
  };
}
