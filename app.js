/* PromptPack Pro — shared app logic.
 *
 * PRODUCTION DEFAULT: the buy form POSTs the real payload to
 * https://mehyar.us/api/pay/checkout and redirects to Stripe.
 * DEV MODE is opt-in ONLY via ?dev=1 (shows the payload modal instead of
 * charging). Never the default, never silent.
 */
"use strict";

var DEV_MODE = new URLSearchParams(window.location.search).get("dev") === "1";
var CHECKOUT_URL = "https://mehyar.us/api/pay/checkout";
var PRODUCT_ID = "promptpack-pro";

window.PromptPack = window.PromptPack || {};

function $(sel, root) {
  return (root || document).querySelector(sel);
}
function $all(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

/* ---------- toast ---------- */
var toastTimer = null;
function toast(msg) {
  var t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
}
window.PromptPack.toast = toast;

/* ---------- copy buttons ---------- */
function wireCopyButtons(root) {
  $all("[data-copy]", root).forEach(function (btn) {
    if (btn.__wired) return;
    btn.__wired = true;
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      function done() {
        btn.classList.add("copied");
        var old = btn.textContent;
        btn.textContent = "Copied ✓";
        toast("Copied to clipboard");
        setTimeout(function () {
          btn.classList.remove("copied");
          btn.textContent = old;
        }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else {
        fallbackCopy(text, done);
      }
    });
  });
}
function fallbackCopy(text, done) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
  done();
}

/* ---------- teaser ---------- */
var teaserCache = {};
function renderTeaser(profession, items) {
  var host = $("#teaser-list");
  if (!host) return;
  var names = {
    "contractor": "Contractor",
    "realtor": "Realtor",
    "coach-consultant": "Coach & Consultant",
    "freelancer": "Freelancer"
  };
  var html = items.map(function (it) {
    return '<article class="prompt-card reveal in">' +
      '<div class="prompt-head">' +
        '<span class="prompt-n">FREE ' + esc(String(it.n)) + '</span>' +
        '<span class="cat">' + esc(it.category) + '</span>' +
      '</div>' +
      "<h3>" + esc(it.title) + "</h3>" +
      '<div class="prompt-text">' + esc(it.prompt) + "</div>" +
      '<button class="copy-btn" type="button" data-copy="' + esc(it.prompt) + '">Copy prompt</button>' +
      "</article>";
  }).join("");
  host.innerHTML = '<p style="text-align:center;margin-bottom:14px"><span class="free-badge">FREE TEASER</span></p>' +
    '<p class="sample-note" style="text-align:center;margin-bottom:16px">Sample prompts for ' +
    esc(names[profession] || profession) + ' — the full pack has 50 more like these, plus 10 swipe files.</p>' + html;
  wireCopyButtons(host);
}
function loadTeaser(profession) {
  var status = $("#teaser-status");
  if (teaserCache[profession]) {
    renderTeaser(profession, teaserCache[profession]);
    if (status) status.textContent = "";
    return;
  }
  if (status) { status.textContent = "Loading free prompts…"; status.className = "status busy"; }
  fetch("/api/promptpack/teaser?profession=" + encodeURIComponent(profession))
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (j) {
      if (!j || !j.ok || !Array.isArray(j.prompts)) throw new Error("bad payload");
      teaserCache[profession] = j.prompts;
      renderTeaser(profession, j.prompts);
      if (status) { status.textContent = ""; status.className = "status"; }
    })
    .catch(function () {
      if (status) {
        status.textContent = "Couldn't load the free prompts — check your connection and try again.";
        status.className = "status error";
      }
    });
}
window.PromptPack.loadTeaser = loadTeaser;

/* ---------- buy modal + checkout ---------- */
function openBuy(profession) {
  var modal = $("#buy-modal");
  if (!modal) return;
  var sel = $("#buy-profession");
  if (sel && profession) sel.value = profession;
  $("#buy-email").value = "";
  $("#buy-error").textContent = "";
  modal.hidden = false;
  var target = sel && !sel.value ? sel : $("#buy-email");
  if (target) target.focus();
}
window.PromptPack.openBuy = openBuy;

function closeBuy() {
  var modal = $("#buy-modal");
  if (modal) modal.hidden = true;
}

function checkoutPayload(email, profession) {
  // NOTE: success_url / cancel_url are intentionally NOT overridden here.
  // The centralized checkout fills {access_token} into the SKU's
  // success_url_template; an override would replace the template and LOSE
  // the token. The promptpack-pro SKU template already points at
  // https://promptpack.mehyar.us/success.html?token={access_token}.
  var payload = {
    product_id: PRODUCT_ID,
    email: email,
    params: { profession: profession }
  };
  if (DEV_MODE) payload.test = true; // dev checkout only ever hits test mode
  return payload;
}

async function liveCheckout(email, profession) {
  var payload = checkoutPayload(email, profession);
  var res;
  try {
    res = await fetch(CHECKOUT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return { ok: false, error: "Couldn't reach checkout — check your connection and try again." };
  }
  var data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.ok !== true || !data.checkout_url) {
    var msg = (data && (data.message || data.error)) || ("Checkout failed (HTTP " + res.status + ").");
    return { ok: false, error: String(msg).slice(0, 200) };
  }
  window.location.href = data.checkout_url;
  return { ok: true };
}

/* ---------- global wiring ---------- */
document.addEventListener("DOMContentLoaded", function () {
  if (DEV_MODE && document.body) {
    var banner = document.createElement("div");
    banner.style.cssText = "position:sticky;top:0;z-index:9999;text-align:center;padding:8px;font-weight:700;background:#f59e0b;color:#1a1206";
    banner.textContent = "DEV MODE (?dev=1) — no real checkout, no charges. Remove ?dev=1 for production.";
    document.body.insertBefore(banner, document.body.firstChild);
  }

  var closeX = $("#buy-close");
  if (closeX) closeX.addEventListener("click", closeBuy);
  var modal = $("#buy-modal");
  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeBuy();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeBuy();
  });

  var buyForm = $("#buy-form");
  if (buyForm) {
    buyForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = $("#buy-email").value.trim();
      var prof = $("#buy-profession").value;
      var err = $("#buy-error");
      if (!prof) {
        err.textContent = "Pick your profession — the pack is built for one trade.";
        $("#buy-profession").focus();
        return;
      }
      if (!validEmail(email)) {
        err.textContent = "Enter a valid email — your pack link goes there.";
        $("#buy-email").focus();
        return;
      }
      err.textContent = "";
      if (DEV_MODE) {
        $("#payload-pre").textContent = "POST " + CHECKOUT_URL + "\n\n" + JSON.stringify(checkoutPayload(email, prof), null, 2);
        $("#payload-modal").hidden = false;
        closeBuy();
        return;
      }
      var btn = buyForm.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Starting secure checkout…"; }
      liveCheckout(email, prof).then(function (r) {
        if (!r.ok) {
          err.textContent = r.error;
          if (btn) { btn.disabled = false; btn.textContent = "Continue to checkout"; }
        }
      });
    });
  }

  var payloadClose = $("#payload-close");
  if (payloadClose) payloadClose.addEventListener("click", function () {
    $("#payload-modal").hidden = true;
  });

  wireCopyButtons(document);
});
