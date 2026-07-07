/*
 * share-kit.js — one shared capability-share UI for the webhost-app suite.
 *
 * The apps on this pod are all one primitive — "share a scoped, revocable capability
 * over something that's mine, without handing over the credential" — but each was
 * expressing it differently (or not at all). share-kit is the small shared UI that makes
 * that shape visible and consistent, so learning one app teaches all of them.
 *
 * It exports THREE pieces (plus the observable ShareHandle that wires them together):
 *   1. ShareKit.shareAction(el, {label, onShare})       — the journey-labeled button
 *   2. ShareKit.capabilityReceipt(el, handle)            — link + scope sentence + revoke + status pill
 *   3. ShareKit.recipientBanner(el, handleOrOpts)        — top strip on a shared view, honest end-states
 *
 * DESIGN SYSTEM: share-kit is a *component* layer, not a token layer — exactly like the
 * pod's components.css. It CONSUMES the host app's pod design tokens (--ink1/--ink2/
 * --paper/--deep/--wash1/--wash2/--i1-text/--i2-text/--warn/--warn-wash/--block/
 * --block-text/--rule/--faint/--card/--cond/--mono/--sans/--off), so it inherits each
 * app's own inking (watermelon classic, grape-acid webhost, …) and light/dark register.
 * Your app must already define them (inline tokens.css / your :root block) — see README.
 * All styles are scoped under `.sk` and every class is `.sk-*`, so the kit never collides
 * with a host app's own .btn / .pill / .card classes.
 *
 * No dependencies, no build, no network. Adopt by inlining this one file into your app's
 * index.html (run share-kit/inline.sh <app>).
 */
(function () {
  "use strict";
  var VERSION = "0.1.0";

  var CSS = [
/* base — consumes host tokens; scoped so it never touches host styles */
".sk{font:15px/1.6 var(--sans);color:var(--text)}",
".sk *{box-sizing:border-box}",
".sk :focus-visible{outline:2px solid var(--ink2);outline-offset:2px}",
".sk .sk-err{font:13px/1.5 var(--mono);color:var(--i2-text);margin-top:8px;min-height:1px}",
/* buttons — hard-edged, two-ink shadow; same grammar as components.css .btn */
".sk .sk-btn{display:inline-flex;align-items:center;gap:8px;font:800 14px var(--cond);text-transform:uppercase;letter-spacing:.12em;border:0;padding:12px 22px;cursor:pointer;background:var(--ink1);color:#fff;box-shadow:3px 3px 0 var(--ink2);border-radius:0}",
".sk .sk-btn:disabled{opacity:.5;cursor:default}",
".sk .sk-btn.danger{background:var(--ink2);color:var(--deep);box-shadow:3px 3px 0 var(--ink1)}",
".sk .sk-btn.quiet{background:transparent;color:var(--text);border:1px solid var(--rule);box-shadow:none;font:600 13px var(--sans);letter-spacing:0;text-transform:none;padding:9px 14px}",
/* status pills — mono; ok/warn/bad (warn is the only third ink) */
".sk .sk-pill{display:inline-flex;align-items:center;gap:6px;font:500 12px/1 var(--mono);padding:4px 10px;border-radius:999px;text-transform:capitalize}",
".sk .sk-pill.ok{background:var(--wash1);color:var(--i1-text)}",
".sk .sk-pill.warn{background:var(--warn-wash);color:var(--warn)}",
".sk .sk-pill.bad{background:var(--wash2);color:var(--i2-text)}",
/* capability receipt — white card with an ink1 frame, like components.css .card */
".sk .sk-card{background:var(--card);border:2.5px solid var(--ink1);padding:16px 18px}",
".sk .sk-receipt-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}",
".sk .sk-title{font:800 16px var(--cond);text-transform:uppercase;letter-spacing:.08em}",
".sk .sk-scope{font:13px/1.5 var(--mono);color:var(--text);margin:10px 0}",
".sk .sk-link-row{display:flex;gap:8px;align-items:stretch}",
".sk .sk-link{flex:1;min-width:0;font:12px var(--mono);padding:8px 10px;border:1.5px solid var(--rule);background:var(--paper);color:var(--text);border-radius:0}",
".sk .sk-acts{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}",
/* recipient banner — full-width top strip; wash ground + ink1 rule, bad/warn variants */
".sk.sk-banner{display:block;background:var(--wash1);border-bottom:2.5px solid var(--ink1);padding:10px 16px;font:13px/1.5 var(--mono);color:var(--text)}",
".sk.sk-banner.bad{background:var(--wash2);border-bottom-color:var(--ink2)}",
".sk.sk-banner.warn{background:var(--warn-wash);border-bottom-color:var(--warn)}",
".sk .sk-banner-inner{max-width:920px;margin:0 auto}",
".sk .sk-cap{font-weight:700;color:var(--i1-text)}",
".sk .sk-sep{color:var(--faint)}"
  ].join("\n");

  // inject <style id=share-kit-css> once. root defaults to document.head.
  function init(root) {
    var r = root || document.head;
    if (!r || r.querySelector("#share-kit-css")) return;
    var s = document.createElement("style");
    s.id = "share-kit-css";
    s.textContent = CSS;
    r.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  /*
   * ShareHandle — the live, observable state of one shared capability.
   *
   * The app creates a handle after it mints a token; BOTH the owner-side receipt and the
   * recipient-side banner subscribe to it, so an owner revoking flips the recipient view
   * to the honest revoked state on its next render. Fields:
   *   link       — the ?token= (or ?code=) URL the recipient opens
   *   scope      — plain-English scope sentence (MUST be true; see README)
   *   owner      — who shared ("you" / a handle)
   *   thing      — what was shared ("X feed" / "one calendar event" / "live meeting")
   *   capability — recipient capability phrase ("read-only" / "edit this event" / …)
   *   status     — "active" | "revoked" | "expired"
   *   onRevoke   — async () => {} that performs the REAL revoke server-side and resolves
   *                only once confirmed. If it throws, the status is NOT flipped (the
   *                receipt re-enables and surfaces the real error — nothing masked).
   */
  function handle(opts) {
    opts = opts || {};
    var h = {
      version: VERSION,
      link: opts.link || "",
      scope: opts.scope || "",
      owner: opts.owner || "the owner",
      thing: opts.thing || "view",
      capability: opts.capability || "read-only",
      status: opts.status || "active",
      onRevoke: typeof opts.onRevoke === "function" ? opts.onRevoke : null,
      _subs: new Set(),
      subscribe: function (fn) { this._subs.add(fn); fn(this); return this; },
      set: function (patch) { Object.assign(this, patch); this._subs.forEach(function (f) { f(h); }); return this; },
      revoke: async function () {
        if (this.status !== "active") return;
        if (this.onRevoke) await this.onRevoke(); // may throw — propagate, do NOT flip
        this.set({ status: "revoked" });
      }
    };
    return h;
  }

  /*
   * 1) SHARE ACTION — the primary button, labeled by the JOURNEY ("Share my feed →"),
   *    never by the mechanism ("mint token"). Renders into `el`.
   *    opts.label   — journey label
   *    opts.onShare — async () => ShareHandle ; mint the capability however your app does
   *    opts.onShared(handle) — called once minted (typically render the receipt here)
   *    While minting the button is disabled; a mint failure is shown inline (no silent stall).
   */
  function shareAction(el, opts) {
    init(); opts = opts || {};
    var host = typeof el === "string" ? document.getElementById(el) : el;
    host.className = "sk"; host.innerHTML = "";
    var btn = el2(host, "button", "sk-btn");
    btn.type = "button"; btn.textContent = opts.label || "Share →";
    var err = el2(host, "div", "sk-err");
    btn.addEventListener("click", async function () {
      btn.disabled = true; var prev = btn.textContent; btn.textContent = "Sharing…"; err.textContent = "";
      try {
        var h = await opts.onShare();
        btn.textContent = "Shared ✓";
        if (typeof opts.onShared === "function") opts.onShared(h);
      } catch (e) {
        btn.disabled = false; btn.textContent = prev;
        err.textContent = String((e && e.message) || e);
      }
    });
    return { button: btn };
  }
  function el2(parent, tag, cls) { var e = el(tag, cls); parent.appendChild(e); return e; }

  /*
   * 2) CAPABILITY RECEIPT — link + plain-English scope sentence + status pill + Revoke.
   *    Renders into `el` from a ShareHandle and re-renders on any handle change, so a
   *    successful revoke flips the pill to "revoked" and disables Revoke.
   */
  function capabilityReceipt(host, h) {
    init();
    host = typeof host === "string" ? document.getElementById(host) : host;
    host.className = "sk";
    h.subscribe(render);
    function render(hh) {
      var st = hh.status;
      var pillCls = st === "active" ? "sk-pill ok" : st === "expired" ? "sk-pill warn" : "sk-pill bad";
      host.innerHTML =
        '<div class="sk-card">' +
          '<div class="sk-receipt-head">' +
            '<b class="sk-title">Shared link</b>' +
            '<span class="' + pillCls + '">' + esc(st) + '</span>' +
          '</div>' +
          '<div class="sk-scope">' + esc(hh.scope) + '</div>' +
          '<div class="sk-link-row">' +
            '<input class="sk-link" readonly value="' + esc(hh.link) + '">' +
            '<button class="sk-btn quiet" type="button" data-act="copy">copy</button>' +
          '</div>' +
          '<div class="sk-acts">' +
            '<button class="sk-btn danger" type="button" data-act="revoke"' + (st === "active" ? "" : " disabled") + '>' +
              (st === "active" ? "Revoke" : "Revoked") + '</button>' +
          '</div>' +
          '<div class="sk-err" data-role="err"></div>' +
        '</div>';
      var copyBtn = host.querySelector('[data-act="copy"]');
      var revokeBtn = host.querySelector('[data-act="revoke"]');
      var errEl = host.querySelector('[data-role="err"]');
      copyBtn.addEventListener("click", function () {
        var inp = host.querySelector(".sk-link");
        inp.select(); inp.setSelectionRange(0, 99999);
        try {
          navigator.clipboard.writeText(inp.value);
          copyBtn.textContent = "copied";
          setTimeout(function () { copyBtn.textContent = "copy"; }, 1200);
        } catch (_) { try { document.execCommand("copy"); } catch (_) {} }
      });
      revokeBtn.addEventListener("click", async function () {
        revokeBtn.disabled = true; var prev = revokeBtn.textContent; revokeBtn.textContent = "Revoking…"; errEl.textContent = "";
        try { await h.revoke(); }
        catch (e) { revokeBtn.disabled = false; revokeBtn.textContent = prev; errEl.textContent = String((e && e.message) || e); }
      });
    }
    return h;
  }

  /*
   * 3) RECIPIENT BANNER — top strip on a shared view.
   *    "You're viewing <owner>'s shared <thing> · <capability>", and an HONEST end-state
   *    when revoked / expired / gone — never a silent stall (anti-hollow-green, applied to UX).
   *    Pass a ShareHandle to stay in sync with an owner-side revoke, or a static opts
   *    object ({owner, thing, capability, status}) to render once.
   */
  function recipientBanner(host, h) {
    init();
    host = typeof host === "string" ? document.getElementById(host) : host;
    function render(hh) {
      var state = hh.status || "active";
      var cap = hh.capability || "read-only";
      var cls = "sk sk-banner";
      var body;
      if (state === "active") {
        body = "You're viewing <b>" + esc(hh.owner) + "</b>'s shared " + esc(hh.thing) +
               ' <span class="sk-sep">·</span> <span class="sk-cap">' + esc(cap) + "</span>";
      } else if (state === "revoked") {
        cls += " bad";
        body = "This share was <b>revoked by the owner</b>. The link no longer works.";
      } else if (state === "expired") {
        cls += " warn";
        body = "This share has <b>expired</b>. Ask the owner for a fresh link.";
      } else { // "gone" or anything unknown — honest, doesn't over-claim a specific reason
        cls += " bad";
        body = "This share is <b>no longer available</b> — it was revoked or has expired.";
      }
      host.className = cls;
      host.innerHTML = '<div class="sk-banner-inner">' + body + "</div>";
    }
    if (h && typeof h.subscribe === "function") { h.subscribe(render); return h; }
    render(Object.assign({ capability: "read-only", status: "active" }, h || {}));
    return h || {};
  }

  window.ShareKit = {
    VERSION: VERSION,
    CSS: CSS,
    init: init,
    handle: handle,
    shareAction: shareAction,
    capabilityReceipt: capabilityReceipt,
    recipientBanner: recipientBanner,
    esc: esc
  };
})();
