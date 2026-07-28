/*
 * share-kit.js — one shared capability-share UI for the webhost-app suite.
 *
 * The apps on this pod are all one primitive — "share a scoped, revocable capability
 * over something that's mine, without handing over the credential" — but each was
 * expressing it differently (or not at all). share-kit is the small shared UI that makes
 * that shape visible and consistent, so learning one app teaches all of them.
 *
 * It exports the capability-SHARE pieces (plus the observable ShareHandle that wires them
 * together), AND the CONNECT half that every relying-party app needs to obtain the scoped
 * token in the first place:
 *   1. ShareKit.shareAction(el, {label, onShare})       — the journey-labeled button
 *   2. ShareKit.capabilityReceipt(el, handle)            — link + scope sentence + revoke + status pill
 *   3. ShareKit.recipientBanner(el, handleOrOpts)        — top strip on a shared view, honest end-states
 *   4. ShareKit.oauth3Connect({plugin,app,node,onStatus,probe}) -> Promise<token>
 *      runs the connect handshake via window.oauth3; if `probe` is given, runs the gated
 *      read and treats a 409 challenge_pending / step-up as RETRYABLE (polls
 *      GET /api/challenge/:id, capped ~20×4s, mirroring otterpilot's proven #61 recover),
 *      re-running the probe on approval; every other failure is TERMINAL and re-thrown so
 *      the app renders the REAL error (no raw dead-end, no mock/mask).
 *      ShareKit.oauth3Read(node, path, token) -> Promise<body> is the gated-read primitive
 *      the probe calls; it throws the step-up marker on 409 challenge_pending.
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
  var VERSION = "0.4.0";

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

  /*
   * 4) OAUTH3 CONNECT — the shared connect handshake + gated-read recovery.
   *
   * Every relying-party app on the pod needs the same thing: ask the OAuth3 wallet for a
   * scoped token, then read through it. They were each hand-rolling it five different ways —
   * and timeline-peek DEAD-ENDED on a step-up, rendering the raw `challenge_pending` string
   * in pink with no recovery. This is the one shared path. Two pieces:
   *
   *   oauth3Connect({plugin, app, node, caps, onStatus, probe}) -> Promise<token>
   *     - runs window.oauth3.connect() (the wallet/extension carries consent + approval and
   *       hands back a bare token string). If NO wallet/extension is present (phone, clean
   *       profile), falls back to wallet self-provision (did:key → /api/login → /api/connect →
   *       approve → poll) instead of dead-ending — fixes the #9 "install the extension"
   *       regression for every adopter at once. Either way the app only ever sees the token.
   *     - optional `caps` (string[]) is forwarded on both paths so a relying party can MINT a
   *       capability-scoped token (e.g. calendar-share's write:event:<id>) through the same
   *       shared handshake instead of hand-rolling a second connect — #67.
   *     - if `probe(token)` is given, runs it AFTER connect. A probe that rejects with the
   *       step-up marker (409 challenge_pending + challengeId, see oauth3Read) is RETRYABLE:
   *       onStatus("waiting-approval") fires, the challenge is polled (capped ~20×4s), and the
   *       probe is re-run on approval. denied/expired/unknown/timeout, and EVERY other probe
   *       error, is TERMINAL — re-thrown so the app surfaces the real message. No mock, no
   *       mask, no raw dead-end.
   *     - onStatus(state, detail) lets the app render the states: "connecting" → "approved" →
   *       "reading" → ("waiting-approval" → "reading")*. Resolves with the token once a probe
   *       (if any) passes; with no probe, resolves right after connect.
   *
   *   oauth3Read(node, path, token) -> Promise<body>
   *     - the gated-read primitive the probe calls (e.g. "/api/twitter/feed"). 409
   *       challenge_pending + challengeId throws the RETRYABLE marker; any other non-2xx
   *       throws a TERMINAL Error carrying the node's real {error}; 2xx returns the parsed
   *       body. A network failure throws a terminal "couldn't reach the oauth3 node" error.
   *
   * The step-up challenge poll mirrors otterpilot's proven recover pattern (webhost-apps
   * #61/#62): the server holds a guarded read for out-of-band approval (RFC 0005) and the
   * app bounces back automatically on approval instead of going down.
   */
  function oauth3Read(node, path, token) {
    return (async function () {
      node = String(node || "").replace(/\/$/, "");
      var r;
      try {
        r = await fetch(node + path, { headers: { Authorization: "Bearer " + token } });
      } catch (e) {
        var ne = new Error("couldn't reach the oauth3 node (" + ((e && e.message) || e) + ")");
        ne.terminal = true; throw ne;
      }
      var body = null;
      try { body = await r.json(); } catch (_) { body = null; }
      if (r.ok) return body || {};
      // step-up (RFC 0005): a 409 with {error:'challenge_pending', challengeId} is retryable.
      if (r.status === 409 && body && body.error === "challenge_pending" && body.challengeId) {
        var se = new Error("challenge_pending");
        se.oauth3StepUp = true; se.challengeId = body.challengeId; throw se;
      }
      // everything else is terminal — surface the node's real error, never mask it.
      var te = new Error((body && (body.error || body.message)) || (path + " " + r.status));
      te.status = r.status; te.terminal = true; throw te;
    })();
  }

  // Poll GET {node}/api/challenge/:id until decided, or the cap is hit (~20×4s ≈ 80s).
  // Returns "approved" | "denied" | "expired" | "unknown" | "timeout". onTick(status, n)
  // lets the caller keep a "waiting…" banner live each round. Network blips are treated as
  // pending (keep polling) so a transient drop doesn't kill an otherwise-recoverable read.
  function pollChallenge(node, id, token, onTick) {
    node = String(node || "").replace(/\/$/, "");
    var attempts = 20, delay = 4000;
    return new Promise(function (resolve) {
      var n = 0;
      (async function loop() {
        while (n < attempts) {
          n++;
          var st = "pending";
          try {
            var r = await fetch(node + "/api/challenge/" + encodeURIComponent(id),
              { headers: { Authorization: "Bearer " + token } });
            if (r.status === 404) { if (onTick) onTick("unknown", n); return resolve("unknown"); }
            var j = null; try { j = await r.json(); } catch (_) {}
            st = (j && (j.status || (j.data && j.data.status))) || (r.ok ? "pending" : "unknown");
          } catch (e) { st = "pending"; }
          if (onTick) onTick(st, n);
          if (st === "approved" || st === "denied" || st === "expired" || st === "unknown") return resolve(st);
          await new Promise(function (rr) { setTimeout(rr, delay); });
        }
        resolve("timeout");
      })();
    });
  }

  /*
   * Wallet self-provision (no extension) — the fallback oauth3Connect uses when
   * window.oauth3 is absent (phone, clean profile), so it no longer dead-ends on "install the
   * extension" (the #9 regression). Verbatim proven flow the relying-party demos each hand-
   * rolled (reddit-karma / timeline-peek / calendar-share): self-provision an Ed25519 did:key
   * in this browser, sign into the node, run /api/connect, self-approve with the wallet
   * session, poll for the scoped token. The private key never leaves the browser; the node
   * only sees the DID + a signature. Centralising it here is the #67 "stop hand-rolling the
   * handshake" cleanup. Every failure (login/connect/approve/poll, incl. the node's layer-1
   * listing 403 "App X is not listed") becomes a terminal Error the app renders honestly —
   * listing is an operator config step, not something this kit can grant.
   */
  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var DK = "oauth3_didkey", SK = "oauth3_session";
  function _b64(u) { return btoa(String.fromCharCode.apply(null, u)); }
  function _b64uDec(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), function (c) { return c.charCodeAt(0); });
  }
  function _b58e(b) {
    var d = [0], i, j, c;
    for (i = 0; i < b.length; i++) {
      c = b[i];
      for (j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; }
      while (c) { d.push(c % 58); c = (c / 58) | 0; }
    }
    var s = "";
    for (i = 0; i < b.length; i++) { if (b[i] === 0) s += "1"; else break; }
    for (j = d.length - 1; j >= 0; j--) s += B58[d[j]];
    return s;
  }
  async function _walletKey() {
    var jwk = JSON.parse(localStorage.getItem(DK) || "null");
    if (!jwk) {
      var kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      localStorage.setItem(DK, JSON.stringify(jwk));
    }
    var priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
    var raw = Array.prototype.slice.call(_b64uDec(jwk.x));
    var did = "did:key:z" + _b58e(Uint8Array.from([0xed, 0x01].concat(raw)));
    return { priv: priv, did: did };
  }
  async function _walletSignIn(node) {
    var stored = localStorage.getItem(SK);
    if (stored) {
      try {
        var me = await (await fetch(node + "/api/me", { headers: { Authorization: "Bearer " + stored } })).json();
        if (me && me.signedIn) return stored;
      } catch (_) {}
    }
    var kr = await _walletKey();
    var ch = (await (await fetch(node + "/api/login/challenge")).json()).challenge;
    var sig = _b64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kr.priv, new TextEncoder().encode(ch))));
    var r = await fetch(node + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: kr.did, challenge: ch, signature: sig })
    });
    var b = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(b.error || ("login " + r.status));
    localStorage.setItem(SK, b.session);
    return b.session;
  }
  async function _connectViaWallet(node, plugin, app, caps) {
    var session = await _walletSignIn(node);
    var cr = await fetch(node + "/api/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(caps && caps.length ? { plugin: plugin, app: app, caps: caps } : { plugin: plugin, app: app })
    });
    var c = await cr.json().catch(function () { return {}; });
    if (!cr.ok) throw new Error(c.error || ("connect " + cr.status));
    var ar = await fetch(node + "/api/connect/" + c.requestId + "/approve", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + session }, body: "{}"
    });
    if (!ar.ok) { var e = await ar.json().catch(function () { return {}; }); throw new Error(e.error || ("approve " + ar.status)); }
    var deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      var s = await (await fetch(node + "/api/connect/" + c.requestId)).json().catch(function () { return {}; });
      if (s.status === "approved" && s.token) return s.token;
      if (s.status === "denied") throw new Error("connect denied by user");
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    throw new Error("connect timed out");
  }

  function oauth3Connect(opts) {
    opts = opts || {};
    var node = String(opts.node || "").replace(/\/$/, "");
    var onStatus = typeof opts.onStatus === "function" ? opts.onStatus : function () {};
    var probe = typeof opts.probe === "function" ? opts.probe : null;
    var MAX_PROBE_ROUNDS = 3;
    return (async function () {
      var token;
      if (typeof window !== "undefined" && window.oauth3 && typeof window.oauth3.connect === "function") {
        // extension path — the wallet/extension carries consent + approval and hands back a
        // bare token string (provider-inject.js). Be defensive about an object {token}/{error}
        // shape too in case a future wallet returns one.
        onStatus("connecting", { plugin: opts.plugin, via: "extension" });
        var got;
        try {
          got = await window.oauth3.connect({ plugin: opts.plugin, app: opts.app, subject: opts.subject, caps: opts.caps, node: node });
        } catch (e) {
          var ce = new Error(String((e && e.message) || e)); ce.terminal = true; throw ce;
        }
        token = (got && typeof got === "object") ? (got.error ? null : got.token) : got;
        if (!token || typeof token !== "string") {
          var ne = new Error((got && got.error) || "connect returned no token (approval denied or cancelled)");
          ne.terminal = true; throw ne;
        }
      } else {
        // no extension (phone, clean profile) → wallet self-provision (did:key → login →
        // connect → approve → poll). Replaces the old "install the extension" dead-end (the
        // #9 regression). Errors — incl. the node's layer-1 listing 403 — surface honestly.
        onStatus("connecting", { plugin: opts.plugin, via: "wallet" });
        try {
          token = await _connectViaWallet(node, opts.plugin, opts.app, opts.caps);
        } catch (e) {
          var we = new Error(String((e && e.message) || e)); we.terminal = true; throw we;
        }
        if (!token || typeof token !== "string") {
          var wne = new Error("connect returned no token (approval denied or cancelled)"); wne.terminal = true; throw wne;
        }
      }
      onStatus("approved", { plugin: opts.plugin });
      if (!probe) return token; // pure-handshake mode

      for (var i = 0; i < MAX_PROBE_ROUNDS; i++) {
        onStatus("reading", { round: i + 1 });
        try {
          await probe(token);
          return token; // read passed — token is known-good
        } catch (e) {
          if (e && e.oauth3StepUp && e.challengeId) {
            onStatus("waiting-approval", { challengeId: e.challengeId, round: i + 1 });
            var decision = await pollChallenge(node, e.challengeId, token, function (st, k) {
              onStatus("waiting-approval", { challengeId: e.challengeId, round: i + 1, poll: st, attempt: k });
            });
            if (decision === "approved") continue; // retry the probe
            var de = new Error("step-up " + decision +
              " — the read needs approval that didn't come through. Try Connect again.");
            de.terminal = true; throw de;
          }
          throw e; // terminal — the app renders the honest, real error
        }
      }
      // The read kept re-triggering step-up past the retry cap — honest terminal fail.
      var ex = new Error("the read kept requiring step-up approval — try Connect again.");
      ex.terminal = true; throw ex;
    })();
  }

  window.ShareKit = {
    VERSION: VERSION,
    CSS: CSS,
    init: init,
    handle: handle,
    shareAction: shareAction,
    capabilityReceipt: capabilityReceipt,
    recipientBanner: recipientBanner,
    oauth3Connect: oauth3Connect,
    oauth3Read: oauth3Read,
    esc: esc
  };
})();
