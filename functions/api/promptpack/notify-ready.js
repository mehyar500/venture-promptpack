// POST /api/promptpack/notify-ready
// Body: { order_token }
// Called by deliverable.html when it renders a ready pack. Triggers the
// buyer deliverable email via mehyar.us (idempotent server-side: the email
// only sends once per order). The PWA itself has no mailer; mehyar.us does.
//
// This exists because generation is client-driven: the webhook/backfill only
// creates the order row, and the buyer's browser drives the 3 generation
// batches. When batch 3 marks the order ready, SOMETHING must send the email.
// That something is this endpoint, called from the deliverable page.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const db = env.LEADS_DB;
    if (!db) return json({ ok: false, error: "db_unavailable" }, 500);

    let body = {};
    try { body = await request.json(); } catch {}
    const token = String(body.order_token || "").trim();
    if (!token || token.length < 16) return json({ ok: false, error: "invalid_token" }, 400);

    const order = await db
      .prepare("SELECT id, status, payment_id, email_sent_at FROM promptpack_orders WHERE access_token = ?")
      .bind(token)
      .first();
    if (!order) return json({ ok: false, error: "not_found" }, 404);
    if (order.status !== "ready") return json({ ok: true, action: "not_ready", status: order.status });
    if (order.email_sent_at) return json({ ok: true, action: "already_sent" });

    // Server-to-server: ask mehyar.us to send the buyer email. The backfill
    // endpoint authenticates by the payment token (which IS this order token
    // after token unification) and sends idempotently.
    const backfillUrl = "https://mehyar.us/api/pay/fulfill-backfill";
    let result = { ok: false };
    try {
      const resp = await fetch(backfillUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      result = await resp.json().catch(() => ({}));
      if (!resp.ok || !result.ok) {
        console.error("promptpack notify-ready: backfill call failed", resp.status, result.error);
        return json({ ok: false, error: "email_trigger_failed" }, 502);
      }
    } catch (e) {
      console.error("promptpack notify-ready: backfill fetch failed", e && e.message);
      return json({ ok: false, error: "email_trigger_failed" }, 502);
    }
    return json({ ok: true, action: result.action || "triggered" });
  } catch (e) {
    console.error("promptpack notify-ready error", e && e.message);
    return json({ ok: false }, 500);
  }
}
