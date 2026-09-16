// pwa/fulfillPromptpack.js
// Standalone ES module: Stripe fulfillment for fulfillment='promptpack' products.
// Called from the shared /api/pay/webhook in mehyar-web and from
// /api/pay/fulfill-backfill.
//
// Contract: fulfillPromptpack({ db, env }, payment)
//   db      — D1 binding (shared mehyar_leads_prod; has promptpack_orders)
//   env     — worker env (unused beyond base URL for logs)
//   payment — billing_payments row {id, product_id, email, access_token,
//             metadata_json}  metadata_json = flat checkout params {profession}
//
// Architecture (2026-09-16): generation is CLIENT-DRIVEN.
//   1. This function ONLY creates the promptpack_orders row (idempotent, one
//      row per payment) and returns immediately. No waitUntil, no background
//      fetch, no email — Cloudflare does not reliably keep waitUntil work
//      alive for multi-minute AI generation chains (observed: orders stuck
//      in 'generating' with only part1 saved).
//   2. The token is REUSED from payment.access_token (the same token Stripe
//      already embedded in success_url). Never generate a new one here —
//      that orphans the Stripe return URL.
//   3. The buyer's deliverable page (deliverable.html?token=) polls
//      /api/promptpack/status and automatically fires the 3 generation
//      batches via /api/promptpack/generate, one model call per request.
//   4. When batch 3 marks the order ready, the PWA triggers the buyer email
//      via a server-to-server call to mehyar.us /api/pay/fulfill-backfill
//      (same token), which sends it idempotently.
//
// Behavior:
//   1. Idempotent: exactly one promptpack_orders row per payment.id
//      (UNIQUE index idx_promptpack_orders_payment). Replays return early.
//   2. Token unification: promptpack_orders.access_token IS
//      payment.access_token. billing_payments.access_token is left untouched.

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const PROFESSIONS = ["contractor", "realtor", "coach-consultant", "freelancer"];

function readProfession(payment) {
  let meta = {};
  try {
    meta = JSON.parse(payment.metadata_json || "{}");
  } catch {}
  // NOTE: the centralized /api/pay/checkout stores body.params FLAT as
  // metadata_json. Accept both the flat shape and a wrapped {inputs:{...}}.
  const inputs = (meta && typeof meta === "object" && meta.inputs) || meta || {};
  const raw = String(inputs.profession || "").toLowerCase().trim();
  return PROFESSIONS.includes(raw) ? raw : "contractor"; // never fail on a bad value
}

export async function fulfillPromptpack({ db, env }, payment) {
  if (!db || !payment || !payment.id) throw new Error("fulfillPromptpack: bad args");
  if (!payment.access_token) throw new Error("fulfillPromptpack: payment has no access_token");

  const productId = payment.product_id;
  const profession = readProfession(payment);

  // ── idempotent order create (one row per payment) ──
  const existing = await db
    .prepare("SELECT id, access_token, status, product_id FROM promptpack_orders WHERE payment_id = ?")
    .bind(payment.id)
    .first();
  if (existing) {
    return { ok: true, replay: true, order_id: existing.id, status: existing.status };
  }

  // Token unification: reuse the payment's access_token (the token Stripe
  // already put in success_url). Generating a new token here orphans the
  // Stripe return URL — the buyer would land on a token that matches nothing.
  const accessToken = payment.access_token;
  const inputsJson = JSON.stringify({ inputs: { profession } });
  const ins = await db
    .prepare(
      "INSERT INTO promptpack_orders (payment_id, product_id, email, inputs_json, status, access_token) " +
        "VALUES (?, ?, ?, ?, 'paid', ?)"
    )
    .bind(payment.id, productId, payment.email, inputsJson, accessToken)
    .run();
  const orderId = ins.meta.last_row_id;

  // Generation + buyer email are client-driven from here (see header).
  // This function returns fast so the webhook/backfill never times out.
  return { ok: true, order_id: orderId, mode: "client-driven", profession, access_token: accessToken };
}
