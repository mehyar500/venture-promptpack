// functions/api/promptpack/status.js
// GET /api/promptpack/status?token=<access_token>
// Token-gated: returns order status + the pack (only when ready).
// Tokens <16 chars → 403; unknown token → 404. Email is masked.

function maskEmail(email) {
  const e = String(email || "");
  const at = e.indexOf("@");
  if (at <= 1) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const head = local.length <= 2 ? local[0] + "*" : local.slice(0, 2) + "***";
  return head + "@" + domain;
}

export async function onRequestGet({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  if (!token || token.length < 16) {
    return json({ ok: false, error: "bad_token" }, 403);
  }
  if (!env.LEADS_DB) {
    return json({ ok: false, error: "misconfigured" }, 500);
  }

  let order;
  try {
    order = await env.LEADS_DB.prepare(
      "SELECT id, product_id, email, inputs_json, status, output_json FROM promptpack_orders WHERE access_token = ?"
    ).bind(token).first();
  } catch (e) {
    console.error("promptpack status: db lookup failed", e && e.message);
    return json({ ok: false, error: "db_error" }, 500);
  }
  if (!order) return json({ ok: false, error: "unknown_token" }, 404);

  let profession = "contractor";
  try {
    const inputs = JSON.parse(order.inputs_json || "{}");
    const p = (inputs && inputs.inputs && inputs.inputs.profession) || inputs.profession;
    if (typeof p === "string" && p.trim()) profession = p.trim().toLowerCase();
  } catch {}

  const ready = order.status === "ready" && !!order.output_json;
  let pack = null;
  if (ready) {
    try {
      pack = JSON.parse(order.output_json);
    } catch {
      pack = null;
    }
  }

  return json({
    ok: true,
    status: order.status,
    profession,
    email_masked: maskEmail(order.email),
    ready: !!pack,
    pack
  });
}
