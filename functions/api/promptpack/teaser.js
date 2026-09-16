// functions/api/promptpack/teaser.js
// GET /api/promptpack/teaser?profession=<slug>
// Returns 5 STATIC, hand-written free prompts for the profession.
// No email required, no AI call, no auth. Light in-memory rate limit,
// fail-open (never block a real visitor on a counter error).
//
// Profession slugs: contractor | realtor | coach-consultant | freelancer

const TEASERS = {
  "contractor": [
    {
      n: 1,
      title: "The 4-Day Quote Follow-Up",
      category: "Follow-ups",
      prompt:
        "Write a 3-sentence follow-up text for a homeowner who requested a [kitchen remodel] quote 4 days ago and went quiet. " +
        "Sound like a busy pro checking in, not a salesman chasing. Warm, confident, zero pressure. " +
        "End with one easy yes-or-no question they can answer in five seconds."
    },
    {
      n: 2,
      title: "The Price Objection Flip",
      category: "Quotes & Estimates",
      prompt:
        "A homeowner says: \"Your estimate is higher than the other guy.\" Write me a calm, 4-sentence response that reframes the " +
        "conversation around what's included, timeline certainty, and warranty — without criticizing the competitor or sounding " +
        "defensive. Give me two versions: one for text message, one for in person."
    },
    {
      n: 3,
      title: "The 5-Star Review Reply",
      category: "Reviews",
      prompt:
        "Write a warm, specific reply to this 5-star Google review for my [trade] business: \"[paste the review here]\". " +
        "Mention the exact work they praised, thank them by name, and invite referrals in one natural sentence. Keep it under 60 words."
    },
    {
      n: 4,
      title: "The Change-Order Clarifier",
      category: "Project Management",
      prompt:
        "Write a clear, friendly change-order message for a mid-project client request: adding [recessed lighting in 3 rooms]. " +
        "State the extra cost, the extra days, and exactly what I need from them (written approval) before we start. " +
        "Professional, no fluff, protects me legally."
    },
    {
      n: 5,
      title: "The Estimate-Machine Content Week",
      category: "Content",
      prompt:
        "Give me 5 Facebook post ideas for a local [trade] contractor that generate estimate requests. For each: the hook (first line), " +
        "the story angle, and the exact call-to-action. Make them feel local and trustworthy, not salesy."
    }
  ],
  "realtor": [
    {
      n: 1,
      title: "The Listing Description That Sells",
      category: "Listings",
      prompt:
        "Write a 150-word listing description for a 3-bed, 2-bath ranch with a new roof, updated kitchen, and a big fenced backyard. " +
        "Lead with the lifestyle the buyer gets, not a spec list. Banned words: cozy, charming, must-see, won't last. " +
        "End with a soft CTA to book a showing."
    },
    {
      n: 2,
      title: "The Open-House Follow-Up",
      category: "Follow-ups",
      prompt:
        "Write a follow-up text for open-house visitors who came through but didn't make an offer. Warm, personal, one question " +
        "that's easy to answer. No pressure, and no \"just checking in\" clichés."
    },
    {
      n: 3,
      title: "The Price-Reduction Conversation",
      category: "Seller Communication",
      prompt:
        "Write me a script for telling a seller we need a price reduction after 30 days with no offers. Be honest and data-led, " +
        "protect the relationship, and give them a clear recommendation with two options. Keep it under 200 words."
    },
    {
      n: 4,
      title: "The Review Ask That Works",
      category: "Reviews",
      prompt:
        "Write a short, natural message asking a happy buyer or seller for a Google review. Make it easy: include where to click " +
        "and one prompt (\"What was the best part of working together?\") so they don't stare at a blank box."
    },
    {
      n: 5,
      title: "The 7-Day Content Sprint",
      category: "Content",
      prompt:
        "Give me 7 Instagram Reel ideas for a realtor in [city] that build trust and generate DMs. For each: the hook (first 3 seconds), " +
        "the point, and the CTA. Mix: 3 educational, 2 behind-the-scenes, 2 neighborhood."
    }
  ],
  "coach-consultant": [
    {
      n: 1,
      title: "The Discovery Call Opener",
      category: "Sales",
      prompt:
        "Write a 2-minute discovery call opening script for a [business/life] coach. Set authority, disarm skepticism, and get the " +
        "prospect talking about their real problem in the first 90 seconds. Include the exact first question to ask."
    },
    {
      n: 2,
      title: "The Proposal Follow-Up",
      category: "Follow-ups",
      prompt:
        "Write a follow-up email for a coaching proposal sent 5 days ago with no reply. Confident, not needy. Reframe the cost as " +
        "the cost of staying stuck. End with one clear next step."
    },
    {
      n: 3,
      title: "The Price Objection Handler",
      category: "Sales",
      prompt:
        "A prospect says \"I can't afford it right now.\" Write me a 3-part response: acknowledge without caving, ask one diagnostic " +
        "question that reveals whether it's really about money, and offer a smaller paid first step that keeps the door open."
    },
    {
      n: 4,
      title: "The Testimonial Extractor",
      category: "Social Proof",
      prompt:
        "Write 5 questions I can send a coaching client that will get me a testimonial which actually sells. They should pull out: " +
        "the before-state, the turning point, the specific result, and why they'd recommend me. Then write the ask message itself."
    },
    {
      n: 5,
      title: "The Authority Content Week",
      category: "Content",
      prompt:
        "Give me 5 LinkedIn post ideas for a [niche] consultant that attract inbound leads. Each: a contrarian hook, the lesson, and " +
        "a soft CTA. No generic motivational fluff — I want posts that make a buyer think \"this person sees my problem.\""
    }
  ],
  "freelancer": [
    {
      n: 1,
      title: "The Proposal That Wins",
      category: "Proposals",
      prompt:
        "Write a freelance proposal for this project: [paste the brief]. Structure: the outcome they get (first line), why I'm the safe " +
        "choice (2 proof bullets), exactly what's included and what's not, timeline, price with one premium option. Under 250 words. " +
        "Confident, no begging."
    },
    {
      n: 2,
      title: "The Scope-Creep Stopper",
      category: "Client Management",
      prompt:
        "A client keeps adding \"quick little\" requests outside the agreed scope. Write me a friendly but firm message that: names the " +
        "new requests, quotes the additional fee, and asks for approval before I continue. Protects the relationship and my rate."
    },
    {
      n: 3,
      title: "The Late-Payment Nudge",
      category: "Client Management",
      prompt:
        "Write a 3-email sequence for an invoice that's 7 / 14 / 30 days overdue. Escalating firmness, always professional. The 30-day " +
        "one mentions pausing work and late fees without burning the bridge."
    },
    {
      n: 4,
      title: "The 5-Star Review Ask",
      category: "Reviews",
      prompt:
        "Write a short message to a happy freelance client asking for a review on [Upwork/Fiverr/Google]. Make it effortless: suggest 2-3 " +
        "things they could mention, and give them the exact link placeholder. Under 80 words."
    },
    {
      n: 5,
      title: "The Inbound Content Engine",
      category: "Content",
      prompt:
        "Give me 5 content ideas for a [skill] freelancer that attract clients instead of likes. For each: the hook, the proof element " +
        "(what result or screenshot to show), and the CTA that starts a conversation about hiring me."
    }
  ]
};

const PROFESSIONS = Object.keys(TEASERS);

// Light in-memory rate limit: 30 teaser fetches / IP / hour. Fail-open.
const hits = new Map();
function rateOk(ip) {
  try {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
    if (arr.length >= 30) return false;
    arr.push(now);
    hits.set(ip, arr);
    // cheap GC: cap map size
    if (hits.size > 5000) {
      const oldest = [...hits.keys()][0];
      hits.delete(oldest);
    }
    return true;
  } catch {
    return true; // fail-open
  }
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  let profession = String(url.searchParams.get("profession") || "contractor")
    .toLowerCase()
    .trim();
  if (!PROFESSIONS.includes(profession)) profession = "contractor";

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  if (!rateOk(ip)) {
    return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  return new Response(
    JSON.stringify({ ok: true, profession, prompts: TEASERS[profession] }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600"
      }
    }
  );
}
