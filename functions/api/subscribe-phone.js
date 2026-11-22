// functions/api/subscribe-phone.js
// POST /api/subscribe-phone — Funnel Farm SMS capture (fleet contract,
// 2026-11-21): phone-led signup from the /prompt-wins/ funnel page.
// Consent is REQUIRED server-side — an unticked box is a 400, never a
// silent drop. Captures land in promptpack_sms_subscribers (LEADS_DB)
// with the consent text version and timestamp stored on the row.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  if (body.sms_consent !== true) return json({ ok: false, error: "consent_required" }, 400);
  const digits = String(body.phone || "").replace(/\D/g, "");
  const phone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (phone.length !== 10) return json({ ok: false, error: "invalid_phone" }, 400);
  const source = String(body.source || "prompt-wins").slice(0, 64);
  const consentVersion = String(body.consent_version || "fleet-sms-v1-2026-11-21").slice(0, 64);
  const name = String(body.first_name || body.name || "").slice(0, 120) || null;
  const zip = String(body.zip || "").slice(0, 16) || null;
  try {
    await env.LEADS_DB.prepare(
      `INSERT INTO promptpack_sms_subscribers (phone, name, zip, source, sms_consent, consent_version, consent_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET name = excluded.name, zip = excluded.zip,
         source = excluded.source, sms_consent = 1,
         consent_version = excluded.consent_version, consent_at = excluded.consent_at,
         status = 'active'`
    ).bind(phone, name, zip, source, consentVersion, new Date().toISOString()).run();
  } catch (e) {
    return json({ ok: false, error: "store failed" }, 500);
  }
  return json({ ok: true });
}
