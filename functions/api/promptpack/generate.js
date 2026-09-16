// functions/api/promptpack/generate.js
// POST /api/promptpack/generate  { order_token, profession, batch }
// Called from the mehyar-web Stripe webhook (fulfillPromptpack) and from the
// deliverable page's retry button. The order_token IS the capability:
// it must match promptpack_orders.access_token.
//
// Design (2026-09-16): ONE model call per request. Three sequential batches —
//   batch 1 → prompts 1-25  → stored in part1_json
//   batch 2 → prompts 26-50 → stored in part2_json
//   batch 3 → 10 swipes     → stored in part3_json, then merged into
//                              output_json and the order marked ready.
// A single request never exceeds one Workers AI call, so it always fits in
// the edge request budget (the old 3-sequential-calls design 524'd).
//
// Flow:
//   1. Validate token → order row, status in (paid, failed, generating).
//      Already ready → return cached (idempotent).
//   2. Run the requested batch (llama-3.3-70b-instruct-fp8-fast,
//      response_format json_object).
//      LESSON (2026-09-15): with json_object this model returns result.response
//      PRE-PARSED as a JS object, not a string. The extractor handles both.
//   3. Validate shape (exact counts, required fields). Retry the call once.
//   4. Batch 3 merges all parts → status='ready', output_json.
//   5. On failure: the batch throws → 500; order stays retryable
//      (deliverable page shows retry; webhook replays are idempotent).
//
// Never expose internals in error responses.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const PROFESSIONS = {
  "contractor": {
    name: "Contractor",
    categories: [
      ["Quotes & Estimates", 8],
      ["Follow-ups", 8],
      ["Reviews & Referrals", 7],
      ["Objection Handling", 7],
      ["Project Management", 7],
      ["Content & Marketing", 7],
      ["Hiring & Crew", 3],
      ["Upsells & Repeat Business", 3]
    ],
    context: "a general/home-improvement contractor (remodels, roofing, plumbing, electrical, landscaping — keep prompts trade-agnostic with [trade] placeholders)"
  },
  "realtor": {
    name: "Realtor",
    categories: [
      ["Listing Descriptions", 8],
      ["Buyer Follow-ups", 8],
      ["Seller Communication", 8],
      ["Reviews & Referrals", 6],
      ["Objection Handling", 7],
      ["Content & Social", 7],
      ["Open Houses", 3],
      ["Expired & FSBO Outreach", 3]
    ],
    context: "a residential real estate agent working buyers and sellers"
  },
  "coach-consultant": {
    name: "Coach & Consultant",
    categories: [
      ["Discovery & Sales Calls", 8],
      ["Proposals & Follow-ups", 8],
      ["Objection Handling", 7],
      ["Testimonials & Social Proof", 6],
      ["Client Onboarding", 6],
      ["Content & Authority", 8],
      ["Pricing & Packaging", 4],
      ["Referrals & Upsells", 3]
    ],
    context: "a business/life coach or independent consultant selling 1:1 and group programs"
  },
  "freelancer": {
    name: "Freelancer",
    categories: [
      ["Proposals & Pitches", 8],
      ["Discovery & Scoping", 6],
      ["Follow-ups", 7],
      ["Scope & Boundaries", 7],
      ["Payments & Invoicing", 6],
      ["Reviews & Referrals", 6],
      ["Content & Inbound", 6],
      ["Upsells & Retainers", 4]
    ],
    context: "an independent freelancer (design, writing, dev, marketing — keep prompts skill-agnostic with [skill] placeholders)"
  }
};

const SWIPE_PLANS = {
  "contractor": [
    ["Quote Follow-Up Text", "Follow-ups"],
    ["Price Objection Reply", "Objection Handling"],
    ["5-Star Review Response", "Reviews"],
    ["Change-Order Notice", "Project Management"],
    ["Estimate Request Reply", "Quotes & Estimates"],
    ["Referral Ask", "Reviews & Referrals"],
    ["No-Show Reschedule", "Follow-ups"],
    ["Deposit Reminder", "Payments"],
    ["Project Completion Message", "Project Management"],
    ["Holiday Check-In", "Repeat Business"]
  ],
  "realtor": [
    ["New Listing Announcement", "Listings"],
    ["Open-House Follow-Up Text", "Follow-ups"],
    ["Price-Reduction Script", "Seller Communication"],
    ["Review Request", "Reviews"],
    ["Buyer Consultation Invite", "Buyer Outreach"],
    ["Expired Listing Outreach", "Prospecting"],
    ["Closing Day Message", "Client Care"],
    ["Referral Ask", "Referrals"],
    ["Neighborhood Market Update", "Content"],
    ["Anniversary Check-In", "Repeat Business"]
  ],
  "coach-consultant": [
    ["Discovery Call Confirmation", "Sales"],
    ["Proposal Follow-Up Email", "Follow-ups"],
    ["Price Objection Reply", "Objection Handling"],
    ["Testimonial Request", "Social Proof"],
    ["Onboarding Welcome", "Client Care"],
    ["Session Reminder", "Client Care"],
    ["Re-engagement Email", "Follow-ups"],
    ["Referral Ask", "Referrals"],
    ["Program Completion Message", "Client Care"],
    ["Win-Back Offer", "Upsells"]
  ],
  "freelancer": [
    ["Proposal Cover Message", "Proposals"],
    ["Follow-Up After Proposal", "Follow-ups"],
    ["Scope-Creep Response", "Boundaries"],
    ["Late-Payment Nudge (7-day)", "Payments"],
    ["Late-Payment Firm Notice (30-day)", "Payments"],
    ["Review Request", "Reviews"],
    ["Project Kickoff Message", "Onboarding"],
    ["Delivery & Handoff Note", "Delivery"],
    ["Referral Ask", "Referrals"],
    ["Retainer Upsell Pitch", "Upsells"]
  ]
};

/** Extract text from env.AI.run() — handles the pre-parsed json_object shape. */
function aiText(out) {
  if (typeof out === "string") return out;
  const r = out && out.response;
  if (r == null) return "";
  return typeof r === "string" ? r : JSON.stringify(r);
}

function parseJson(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("empty_response");
  try {
    return JSON.parse(t);
  } catch {
    // salvage: grab the largest {...} block
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error("unparseable_json");
  }
}

function systemPreamble(prof) {
  return (
    "You write AI prompts for " + prof.context + ". " +
    "Every prompt you produce must be a COMPLETE, copy-paste-ready prompt a busy professional can paste into ChatGPT or Claude as-is — " +
    "not advice about prompting, not a description, not meta-commentary. " +
    "Use [bracketed] placeholders for details the user fills in (trade, client name, situation). " +
    "Each prompt must name the situation, the desired tone, and the exact output format. " +
    "HARD RULES: no superlatives without proof (never 'best', 'only', '#1', 'guaranteed'); " +
    "no generic motivational fluff; concrete and trade-specific. " +
    "Respond with JSON ONLY — no markdown fences, no prose."
  );
}

async function runPromptCall(env, profKey, startN, endN) {
  const prof = PROFESSIONS[profKey];
  const userMsg =
    "Write prompts number " + startN + " through " + endN + " (exactly " + (endN - startN + 1) + " prompts) " +
    "for a " + prof.name + ", distributed across these categories (use each category's share as a guide):\n" +
    prof.categories.map(([c, n]) => "- " + c + " (~" + n + " of the full 50)").join("\n") +
    "\n\nFor this batch, spread across the categories sensibly. " +
    "Return JSON exactly like: {\"prompts\": [{\"title\": \"...\", \"category\": \"...\", \"prompt\": \"...\"}, ...]} " +
    "with EXACTLY " + (endN - startN + 1) + " items in the prompts array. " +
    "Titles are short and punchy (e.g. \"The 4-Day Quote Follow-Up\"). Categories must come from the list above.";
  const out = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPreamble(prof) },
      { role: "user", content: userMsg }
    ],
    max_tokens: 6000,
    temperature: 0.75,
    response_format: { type: "json_object" }
  });
  const data = parseJson(aiText(out));
  const items = data && data.prompts;
  if (!Array.isArray(items) || items.length !== endN - startN + 1) {
    throw new Error("bad_count: expected " + (endN - startN + 1) + ", got " + (Array.isArray(items) ? items.length : "non-array"));
  }
  items.forEach((it, i) => {
    if (!it || typeof it.title !== "string" || !it.title.trim()) throw new Error("bad_item:title@" + i);
    if (typeof it.category !== "string" || !it.category.trim()) throw new Error("bad_item:category@" + i);
    if (typeof it.prompt !== "string" || it.prompt.trim().length < 60) throw new Error("bad_item:prompt@" + i);
    // strip superlatives the model sneaks in
    it.prompt = String(it.prompt).replace(/\b(the\s+)?(best|#1|number one|only)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  });
  return items;
}

async function runSwipeCall(env, profKey) {
  const prof = PROFESSIONS[profKey];
  const plan = SWIPE_PLANS[profKey];
  const userMsg =
    "Write 10 copy-paste SWIPE FILES for a " + prof.name + " — fully written messages, no AI call needed. " +
    "Exactly these 10, in this order:\n" +
    plan.map(([t, c], i) => (i + 1) + ". " + t + " [" + c + "]").join("\n") +
    "\n\nEach swipe file: ready to send after filling [bracketed] placeholders (names, amounts, dates). " +
    "Warm, professional, confident tone — written like a top performer in the trade actually talks. " +
    "Keep each under 120 words. " +
    "Return JSON exactly like: {\"swipes\": [{\"title\": \"...\", \"category\": \"...\", \"text\": \"...\"}, ...]} " +
    "with EXACTLY 10 items.";
  const out = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPreamble(prof) },
      { role: "user", content: userMsg }
    ],
    max_tokens: 6000,
    temperature: 0.75,
    response_format: { type: "json_object" }
  });
  const data = parseJson(aiText(out));
  const items = data && data.swipes;
  if (!Array.isArray(items) || items.length !== 10) {
    throw new Error("bad_count: expected 10 swipes, got " + (Array.isArray(items) ? items.length : "non-array"));
  }
  items.forEach((it, i) => {
    if (!it || typeof it.title !== "string" || !it.title.trim()) throw new Error("bad_item:title@" + i);
    if (typeof it.category !== "string" || !it.category.trim()) throw new Error("bad_item:category@" + i);
    if (typeof it.text !== "string" || it.text.trim().length < 40) throw new Error("bad_item:text@" + i);
    it.text = String(it.text).replace(/\b(the\s+)?(best|#1|number one|only)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  });
  return items;
}

async function withRetry(fn, label, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.error("promptpack generate: " + label + " attempt " + i + " failed:", e && e.message);
    }
  }
  throw last;
}

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export async function onRequestPost({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const orderToken = String(body.order_token || "").trim();
  let profKey = String(body.profession || "contractor").toLowerCase().trim();
  if (!PROFESSIONS[profKey]) profKey = "contractor";
  const batch = Number(body.batch || 0);

  if (!orderToken || orderToken.length < 16) {
    return json({ ok: false, error: "bad_token" }, 403);
  }
  if (!env.LEADS_DB) {
    return json({ ok: false, error: "misconfigured" }, 500);
  }
  if (batch !== 1 && batch !== 2 && batch !== 3) {
    return json({ ok: false, error: "bad_batch" }, 400);
  }

  let order;
  try {
    order = await env.LEADS_DB.prepare(
      "SELECT id, status, output_json, part1_json, part2_json, part3_json, product_id FROM promptpack_orders WHERE access_token = ?"
    ).bind(orderToken).first();
  } catch (e) {
    console.error("promptpack generate: db lookup failed", e && e.message);
    return json({ ok: false, error: "db_error" }, 500);
  }
  if (!order) return json({ ok: false, error: "unknown_token" }, 404);
  if (order.status === "ready" && order.output_json) {
    return json({ ok: true, cached: true, batch, ready: true });
  }
  if (order.status !== "paid" && order.status !== "failed" && order.status !== "generating") {
    return json({ ok: false, error: "bad_status", status: order.status }, 409);
  }

  // Mark generating (first batch) to avoid double-work from concurrent kicks.
  if (order.status !== "generating") {
    try {
      await env.LEADS_DB.prepare(
        "UPDATE promptpack_orders SET status='generating' WHERE id=? AND status IN ('paid','failed')"
      ).bind(order.id).run();
    } catch {}
  }

  try {
    if (batch === 1) {
      const p1 = await withRetry(() => runPromptCall(env, profKey, 1, 25), "prompts_1_25");
      await env.LEADS_DB.prepare("UPDATE promptpack_orders SET part1_json=? WHERE id=?")
        .bind(JSON.stringify(p1), order.id).run();
      return json({ ok: true, batch: 1, count: p1.length });
    }
    if (batch === 2) {
      const p2 = await withRetry(() => runPromptCall(env, profKey, 26, 50), "prompts_26_50");
      await env.LEADS_DB.prepare("UPDATE promptpack_orders SET part2_json=? WHERE id=?")
        .bind(JSON.stringify(p2), order.id).run();
      return json({ ok: true, batch: 2, count: p2.length });
    }
    // batch 3: swipes, then merge everything and mark ready.
    const swipes = await withRetry(() => runSwipeCall(env, profKey), "swipes");
    await env.LEADS_DB.prepare("UPDATE promptpack_orders SET part3_json=? WHERE id=?")
      .bind(JSON.stringify(swipes), order.id).run();

    const fresh = await env.LEADS_DB.prepare(
      "SELECT part1_json, part2_json, part3_json FROM promptpack_orders WHERE id=?"
    ).bind(order.id).first();
    const p1 = JSON.parse(fresh.part1_json || "null");
    const p2 = JSON.parse(fresh.part2_json || "null");
    if (!Array.isArray(p1) || p1.length !== 25 || !Array.isArray(p2) || p2.length !== 25) {
      throw new Error("missing_part: run batches 1 and 2 first");
    }
    const pack = {
      profession: profKey,
      profession_name: PROFESSIONS[profKey].name,
      prompts: [...p1, ...p2].map((p, i) => ({ n: i + 1, title: p.title, category: p.category, prompt: p.prompt })),
      swipes: swipes.map((s, i) => ({ n: i + 1, title: s.title, category: s.category, text: s.text })),
      generated_at: new Date().toISOString()
    };
    await env.LEADS_DB.prepare(
      `UPDATE promptpack_orders SET status='ready', output_json=?, ready_at=${nowSql} WHERE id=?`
    ).bind(JSON.stringify(pack), order.id).run();
    console.log("promptpack generate: order", order.id, "ready");
    return json({ ok: true, batch: 3, ready: true, prompts: 50, swipes: 10 });
  } catch (e) {
    console.error("promptpack generate: batch", batch, "failed for order", order.id, e && e.message);
    return json({ ok: false, error: "generation_failed" }, 500);
  }
}
