/**
 * Frontdesk widget - single-file, single-script-tag embed.
 *
 * Integration (one line, works on any site regardless of CMS/framework):
 *   <script src="https://cdn.example.com/frontdesk-widget.js"
 *           data-business="dentistw4" data-config-url="https://.../configs/dentistw4.json"
 *           defer></script>
 *
 * Design choices, all deliberate for "will this pass an IT review":
 * - Everything mounts inside a Shadow DOM: the host site's CSS can never leak in,
 *   and our styles can never leak out. No global class names, no !important wars.
 * - All rendered text goes through textContent / a strict escaper - never innerHTML
 *   with unescaped input - so there is no XSS surface even though this renders
 *   both business-config content and visitor-typed text.
 * - No third-party requests beyond the one config JSON fetch (same-origin or the
 *   CDN it's served from). No trackers, no cookies, no localStorage of PII.
 * - No inline <script> or <style> injected into the host page's own DOM - only
 *   into our own shadow root - so a host site's Content-Security-Policy on its
 *   own document is unaffected.
 * - If a real AI backend is configured (data-api-url), the widget calls it
 *   with a short timeout and falls back to the local keyword matcher on any
 *   failure or timeout - so a slow/down backend degrades gracefully instead
 *   of breaking the widget for the visitor. See ../SECURITY.md for what the
 *   backend does to stay safe (scoped system prompt, rate limiting, hard
 *   provider-side spend cap).
 */
(function () {
  "use strict";

  var scriptEl = document.currentScript;
  var businessKey = scriptEl.getAttribute("data-business") || "demo";
  var configUrl = scriptEl.getAttribute("data-config-url");
  var apiUrl = scriptEl.getAttribute("data-api-url"); // optional - omit to run keyword-only
  var leadApiUrl = scriptEl.getAttribute("data-lead-api-url") || (apiUrl ? apiUrl.replace(/\/chat$/, "/lead") : null);

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }

  var DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  // config.hours (optional) looks like: { "mon": ["09:00","18:00"], ...,
  // "sun": null }. Missing/absent = we simply don't know, so we stay
  // silent about open/closed rather than guessing. Uses the visitor's own
  // local clock - a reasonable stand-in for the business's local time
  // since both are almost always the same city for a local-business widget.
  function isOpenNow(config) {
    if (!config.hours) return null;
    var now = new Date();
    var todays = config.hours[DAY_KEYS[now.getDay()]];
    if (!todays) return false;
    var mins = now.getHours() * 60 + now.getMinutes();
    var toMins = function (t) { var p = t.split(":"); return (+p[0]) * 60 + (+p[1]); };
    return mins >= toMins(todays[0]) && mins < toMins(todays[1]);
  }

  function matchAnswer(config, question) {
    var q = question.toLowerCase();
    var faqs = config.faqs || [];
    for (var i = 0; i < faqs.length; i++) {
      var keywords = faqs[i].keywords || [];
      for (var k = 0; k < keywords.length; k++) {
        if (q.indexOf(keywords[k]) !== -1) return faqs[i].answer;
      }
    }
    return config.fallbackAnswer ||
      "I'll pass that on to the team and someone will get back to you shortly. In the meantime, would you like to leave your name and number?";
  }

  function buildStyles(theme) {
    var side = theme.position === "left" ? "left" : "right";
    var other = side === "left" ? "right" : "left";
    var radiusCorner = side === "left" ? "bottom-left" : "bottom-right";
    var offset = theme.offset || "20px";

    return (
      ":host, * { box-sizing: border-box; }" +
      // `color` is an inherited CSS property, so without an explicit value
      // here it silently inherits from whatever text color the HOST page
      // happens to use - on a dark site with light body text, that leaked
      // straight through into the widget's white message bubbles, making
      // bot replies nearly invisible. Shadow DOM isolates most things
      // automatically, but inherited properties like this one are the
      // exception - they cross the boundary unless reset explicitly here.
      ".fd-root { font-family: " + (theme.fontFamily || "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif") + "; color: #1a1a1a; }" +
      ".fd-bubble {" +
      "  position: fixed; " + side + ": " + offset + "; bottom: " + offset + "; width: 58px; height: 58px;" +
      "  border-radius: 50%; background: var(--fd-accent, #ff7a59); color: #fff;" +
      "  display: flex; align-items: center; justify-content: center;" +
      "  box-shadow: 0 4px 16px rgba(0,0,0,.2); cursor: pointer; z-index: 999999; border: none;" +
      "  animation: fd-pop-in .5s cubic-bezier(.34,1.56,.64,1), fd-idle-pulse 2.8s ease-in-out 1.2s infinite;" +
      "}" +
      // Entrance: arrives with a little life in it rather than just being
      // statically present on load. Idle pulse: a soft breathing glow, not
      // a jittery scale-bounce - reads as "alive and waiting", not "look at
      // me, look at me" nagging. Both pause the instant it's clicked once
      // (see .fd-bubble.fd-settled below) - the point is to draw a first
      // glance, not to keep tugging at someone who's already engaged.
      "@keyframes fd-pop-in { 0% { transform: scale(0); opacity: 0; } 70% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); } }" +
      "@keyframes fd-idle-pulse {" +
      "  0%, 100% { box-shadow: 0 4px 16px rgba(0,0,0,.2), 0 0 0 0 color-mix(in srgb, var(--fd-accent, #ff7a59) 0%, transparent); }" +
      "  50% { box-shadow: 0 4px 16px rgba(0,0,0,.2), 0 0 0 8px color-mix(in srgb, var(--fd-accent, #ff7a59) 18%, transparent); }" +
      "}" +
      ".fd-bubble.fd-settled { animation: none; }" +
      // Fill the full bubble circle, not a small icon floating inside it -
      // fine for the old icon's own internal padding, but left a real
      // photo looking tiny with empty space around it.
      ".fd-bubble svg, .fd-bubble img { width: 100%; height: 100%; display: block; }" +
      ".fd-bubble img { border-radius: 50%; object-fit: cover; }" +
      ".fd-panel {" +
      "  position: fixed; " + side + ": " + offset + "; bottom: calc(" + offset + " + 70px); width: 368px; max-width: calc(100vw - 32px);" +
      "  height: 500px; max-height: calc(100vh - 140px); border-radius: 22px;" +
      "  box-shadow: 0 20px 56px rgba(0,0,0,.28); display: none; flex-direction: column;" +
      "  overflow: visible; z-index: 999999;" +
      "  animation: fd-pop-in .32s cubic-bezier(.34,1.56,.64,1);" +
      "}" +
      ".fd-panel-inner { display: flex; flex-direction: column; height: 100%; border-radius: 22px; overflow: hidden; background: #fff; }" +
      // A small rounded tail connecting the panel back down to the bubble it
      // came from - the visual grammar of a speech bubble, not a floating
      // corporate card that happens to appear near the icon. Sits behind
      // .fd-panel-inner in paint order (comes first in the DOM/CSS here,
      // and .fd-panel itself has no background of its own to cover it),
      // so no z-index trickery needed - the top half is naturally hidden
      // under the white inner panel, leaving just the pointed tip visible.
      ".fd-panel::before {" +
      "  content: ''; position: absolute; bottom: -9px; " + side + ": 26px; width: 22px; height: 22px;" +
      "  background: var(--fd-accent, #ff7a59); clip-path: polygon(0 0, 100% 0, 15% 100%);" +
      "}" +
      ".fd-panel.fd-open { display: flex; }" +
      // Flat base color first (this is what most visitors register at a
      // glance), then one deliberate "alive" touch layered on top: a
      // slow, soft, multi-hue sheen derived entirely from the business's
      // own accent color (never a fixed rainbow) - reads as quietly
      // intelligent rather than a loud gradient background. Confined to
      // this one spot on purpose - the rest of the panel stays flat.
      ".fd-header {" +
      "  background: var(--fd-accent, #ff7a59);" +
      "  color: var(--fd-on-accent, #fff); padding: 18px 18px 20px; display: flex; align-items: center; gap: 12px; position: relative; overflow: hidden;" +
      "}" +
      ".fd-header::before {" +
      "  content: ''; position: absolute; inset: -40%; z-index: 0; opacity: .55; mix-blend-mode: soft-light;" +
      "  background: linear-gradient(120deg," +
      "    color-mix(in srgb, var(--fd-accent, #ff7a59) 55%, #7c5cff)," +
      "    color-mix(in srgb, var(--fd-accent, #ff7a59) 55%, #00d4c6)," +
      "    color-mix(in srgb, var(--fd-accent, #ff7a59) 55%, #ffb020)," +
      "    color-mix(in srgb, var(--fd-accent, #ff7a59) 55%, #7c5cff));" +
      "  background-size: 300% 300%; animation: fd-sheen 14s ease-in-out infinite;" +
      "}" +
      "@keyframes fd-sheen {" +
      "  0%, 100% { background-position: 0% 50%; }" +
      "  50% { background-position: 100% 50%; }" +
      "}" +
      "@media (prefers-reduced-motion: reduce) { .fd-header::before { animation: none; } }" +
      ".fd-header > * { position: relative; z-index: 1; }" +
      ".fd-header img, .fd-face-sm { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex-shrink: 0; display: block; box-shadow: 0 2px 8px rgba(0,0,0,.2); }" +
      ".fd-face-sm svg { width: 100%; height: 100%; display: block; }" +
      ".fd-bubble { overflow: hidden; }" +
      ".fd-header .fd-name { font-weight: 700; font-size: 15px; }" +
      ".fd-header .fd-sub { font-size: 12px; opacity: .9; margin-top: 3px; }" +
      ".fd-close {" +
      "  position: absolute; top: 12px; right: 12px; width: 24px; height: 24px; border-radius: 50%;" +
      "  border: none; background: rgba(255,255,255,.22); color: inherit; cursor: pointer; font-size: 15px;" +
      "  display: flex; align-items: center; justify-content: center; line-height: 1; padding: 0;" +
      "}" +
      ".fd-close:hover { background: rgba(255,255,255,.34); }" +
      ".fd-leave-link { display: inline-flex; align-items: center; gap: 6px; }" +
      // A small face next to each bot reply reads as a real conversation
      // rather than a wall of unattributed text - the same avatar used in
      // the header, just small. User's own messages don't get one,
      // matching how most chat UIs only attribute the OTHER party.
      ".fd-msg-row { display: flex; align-items: flex-end; gap: 8px; margin-bottom: 8px; }" +
      ".fd-msg-row .fd-msg { margin-bottom: 0; }" +
      ".fd-msg-avatar { width: 24px; height: 24px; border-radius: 50%; overflow: hidden; flex-shrink: 0; display: block; }" +
      ".fd-msg-avatar svg, .fd-msg-avatar img { width: 100%; height: 100%; display: block; object-fit: cover; }" +
      // The opening moment - just the name, no large avatar graphic taking
      // up space above it (that's what the small header avatar is for).
      ".fd-hero { text-align: center; padding: 18px 22px 4px; background: linear-gradient(180deg, color-mix(in srgb, var(--fd-accent, #ff7a59) 10%, #fff), #fff 70%); }" +
      ".fd-hero-text { font-size: 16px; font-weight: 700; line-height: 1.35; color: #1a1a1a; }" +
      ".fd-messages { flex: 1; overflow-y: auto; padding: 12px; background: #f7f8fa; }" +
      ".fd-msg { max-width: 85%; margin-bottom: 8px; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; animation: fd-msg-in .18s ease-out; }" +
      "@keyframes fd-msg-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }" +
      ".fd-msg.fd-bot { background: #fff; border: 1px solid #e5e7eb; border-" + radiusCorner + "-radius: 2px; }" +
      ".fd-msg.fd-user { background: var(--fd-accent, #ff7a59); color: var(--fd-on-accent, #fff); margin-" + other + ": auto; border-bottom-" + other + "-radius: 2px; }" +
      ".fd-feedback { display: flex; align-items: center; gap: 6px; margin: -4px 0 8px; }" +
      ".fd-answered-by { font-size: 10px; color: #a8adb5; margin-right: auto; }" +
      ".fd-feedback button { border: none; background: none; cursor: pointer; font-size: 12px; opacity: .35; padding: 2px 4px; }" +
      ".fd-feedback button:hover { opacity: .8; }" +
      ".fd-feedback button.fd-picked { opacity: 1; }" +
      ".fd-inputrow { display: flex; border-top: 1px solid #eee; padding: 8px; gap: 6px; }" +
      ".fd-input { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; }" +
      ".fd-send { background: var(--fd-accent, #ff7a59); color: var(--fd-on-accent, #fff); border: none; border-radius: 8px; padding: 0 14px; font-size: 13px; font-weight: 600; cursor: pointer; }" +
      ".fd-leave-link { border: none; background: none; color: var(--fd-accent, #ff7a59); font-size: 11px; text-decoration: underline; cursor: pointer; padding: 4px 12px 0; text-align: left; }" +
      ".fd-lead-form { display: none; padding: 10px 12px; border-top: 1px solid #eee; background: #fbfbfc; }" +
      ".fd-lead-form.fd-open { display: block; }" +
      ".fd-lead-form input { width: 100%; margin-bottom: 6px; border: 1px solid #ddd; border-radius: 7px; padding: 7px 9px; font-size: 12px; font-family: inherit; }" +
      ".fd-lead-form .fd-lead-actions { display: flex; gap: 6px; }" +
      ".fd-lead-form button { flex: 1; border: none; border-radius: 7px; padding: 7px; font-size: 12px; font-weight: 600; cursor: pointer; }" +
      ".fd-lead-submit { background: var(--fd-accent, #ff7a59); color: var(--fd-on-accent, #fff); }" +
      ".fd-lead-cancel { background: #eee; color: #333; }" +
      ".fd-lead-status { font-size: 11px; margin-top: 6px; min-height: 14px; }" +
      ".fd-lead-status.fd-err { color: #c00; }" +
      ".fd-lead-status.fd-ok { color: #1a7f37; }" +
      ".fd-disclaimer { font-size: 10px; color: #999; padding: 6px 12px; text-align: center; }" +
      ".fd-typing { display: flex; gap: 3px; padding: 10px 12px; }" +
      ".fd-typing span { width: 6px; height: 6px; border-radius: 50%; background: #bbb; animation: fd-bounce 1.2s infinite; }" +
      ".fd-typing span:nth-child(2) { animation-delay: .15s; }" +
      ".fd-typing span:nth-child(3) { animation-delay: .3s; }" +
      "@keyframes fd-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }" +
      "@media (max-width: 480px) {" +
      "  .fd-panel { right: 8px; left: 8px; width: auto; bottom: 84px; height: 70vh; max-height: 70vh; }" +
      "  .fd-bubble { " + side + ": 14px; bottom: 14px; }" +
      "}" +
      // Trial ended / subscription cancelled - a muted, non-interactive
      // bubble instead of the full chat. No click handler is ever attached
      // in this state, so this is never just a styling difference.
      ".fd-bubble.fd-inactive { cursor: default; opacity: .55; animation: none; }" +
      ".fd-inactive-note {" +
      "  position: fixed; " + side + ": " + offset + "; bottom: calc(" + offset + " + 64px);" +
      "  background: #1a1a1a; color: #fff; font-size: 11px; padding: 6px 10px; border-radius: 8px;" +
      "  z-index: 999999; white-space: nowrap; opacity: .85;" +
      "}"
    );
  }

  // Accent color is fully configurable (per-business, or picked freely via
  // the site's own color swatch) - hardcoding white text on it breaks the
  // moment someone picks a pale color. Compute readable text color instead
  // of assuming.
  function contrastTextColor(hex) {
    var c = (hex || "").replace("#", "");
    if (c.length === 3) c = c.split("").map(function (ch) { return ch + ch; }).join("");
    if (!/^[0-9a-f]{6}$/i.test(c)) return "#ffffff";
    var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    var brightness = (r * 299 + g * 587 + b * 114) / 1000; // perceived brightness, 0-255
    return brightness >= 150 ? "#1a1a1a" : "#ffffff";
  }

  // No longer the default active-state face (that's now a real photo, see
  // DEFAULT_AVATAR_URL below) - kept only for the inactive/trial-ended
  // state, where a generic neutral mark reads better than showing a real
  // person's photo next to an "offline" notice.
  function defaultAvatarSvg() {
    return '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="fd-face-grad" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#ffb37a"/><stop offset="100%" stop-color="#ff7a59"/>' +
      '</linearGradient></defs>' +
      '<circle cx="20" cy="20" r="19" fill="url(#fd-face-grad)"/>' +
      '<circle cx="14" cy="19" r="2.3" fill="#3a1f14"/>' +
      '<circle cx="26" cy="19" r="2.3" fill="#3a1f14"/>' +
      '<path d="M13 25 Q20 30.5 27 25" stroke="#3a1f14" stroke-width="2.3" fill="none" stroke-linecap="round"/>' +
      '</svg>';
  }

  // The default face for any business that hasn't uploaded their own -
  // hosted on our own domain since the widget itself gets embedded on
  // arbitrary third-party sites via a single script tag, so this needs to
  // be a real absolute URL, not a relative path.
  var DEFAULT_AVATAR_URL = "https://frontdesk-ai-chi-ten.vercel.app/site/assets/images/ivy-avatar.jpg";

  // Back-compat: older configs set accentColor at the top level. Newer
  // configs use a theme object so more than just color is customizable
  // without touching widget code - just the per-business config.
  function resolveTheme(config) {
    var t = config.theme || {};
    return {
      accentColor: t.accentColor || config.accentColor || "#ff7a59",
      position: t.position || "right",
      offset: t.offset,
      avatarUrl: t.avatarUrl || DEFAULT_AVATAR_URL,
      assistantName: t.assistantName || config.assistantName || "Ivy",
      fontFamily: t.fontFamily || null
    };
  }

  // opts lets a caller (the auto-init below, or window.FrontdeskWidget.mount)
  // override the per-instance business key / backend URLs instead of always
  // using the <script> tag's own attributes - needed so a page can host a
  // second, independent widget instance (e.g. a live "try it for your
  // business" preview) without it fighting the main installed one.
  function init(config, opts) {
    opts = opts || {};
    var instanceKey = opts.businessKey || businessKey;
    var instanceApiUrl = "apiUrl" in opts ? opts.apiUrl : apiUrl;
    var instanceLeadApiUrl = "leadApiUrl" in opts ? opts.leadApiUrl : leadApiUrl;
    var theme = resolveTheme(config);

    var host = document.createElement("div");
    host.setAttribute("data-frontdesk-widget", instanceKey);
    if (opts.container) {
      opts.container.appendChild(host);
    } else {
      document.body.appendChild(host);
    }
    var shadow = host.attachShadow({ mode: "open" });

    var style = document.createElement("style");
    style.textContent = buildStyles(theme);
    shadow.appendChild(style);

    var root = document.createElement("div");
    root.className = "fd-root";
    root.style.setProperty("--fd-accent", theme.accentColor);
    root.style.setProperty("--fd-on-accent", contrastTextColor(theme.accentColor));

    // Trial cancelled or a renewal charge failed - the config file itself
    // still exists (so an install doesn't just 404), but the assistant
    // should visibly stop working rather than keep answering for free
    // forever. This is the primary, always-effective layer since the
    // config is public and fetched directly; api/chat.js and api/lead.js
    // enforce the same thing server-side as a defense-in-depth backstop.
    // No fetch calls to either endpoint ever happen in this branch.
    if (config.active === false) {
      root.innerHTML =
        '<div class="fd-bubble fd-inactive">' + defaultAvatarSvg() + "</div>" +
        '<div class="fd-inactive-note">This assistant is no longer available</div>';
      shadow.appendChild(root);
      return { destroy: function () { host.remove(); } };
    }

    var bubbleInner = theme.avatarUrl
      ? '<img src="' + escapeHtml(theme.avatarUrl) + '" alt="" />'
      : defaultAvatarSvg();
    var headerAvatar = theme.avatarUrl
      ? '<img src="' + escapeHtml(theme.avatarUrl) + '" alt="" />'
      : '<span class="fd-face-sm">' + defaultAvatarSvg() + '</span>';

    root.innerHTML =
      '<button class="fd-bubble" aria-label="Chat with us" type="button">' + bubbleInner + "</button>" +
      '<div class="fd-panel"><div class="fd-panel-inner">' +
      '<div class="fd-header">' + headerAvatar + '<div><div class="fd-name"></div><div class="fd-sub"></div></div>' +
      '<button class="fd-close" type="button" aria-label="Close chat">&#10005;</button></div>' +
      '<div class="fd-messages"></div>' +
      '<button class="fd-leave-link" type="button">&#128197; Leave your details for a callback</button>' +
      '<div class="fd-lead-form">' +
      '<input class="fd-lead-name" type="text" placeholder="Your name" />' +
      '<input class="fd-lead-contact" type="text" placeholder="Phone or email" />' +
      '<div class="fd-lead-actions">' +
      '<button class="fd-lead-submit" type="button">Send</button>' +
      '<button class="fd-lead-cancel" type="button">Cancel</button>' +
      "</div>" +
      '<div class="fd-lead-status"></div>' +
      "</div>" +
      '<div class="fd-inputrow"><input class="fd-input" type="text" placeholder="Type a question..." /><button class="fd-send" type="button">Send</button></div>' +
      '<div class="fd-disclaimer">' + escapeHtml(theme.assistantName) + " is an AI assistant - honest about that, always. For medical or urgent concerns, please call or book directly.</div>" +
      "</div></div>";
    shadow.appendChild(root);

    root.querySelector(".fd-name").textContent = config.businessName || "Chat with us";
    root.querySelector(".fd-sub").textContent = "Hi, I'm " + theme.assistantName + " - usually replies instantly";

    var bubble = root.querySelector(".fd-bubble");
    var panel = root.querySelector(".fd-panel");
    var closeBtn = root.querySelector(".fd-close");
    var messages = root.querySelector(".fd-messages");
    var input = root.querySelector(".fd-input");
    var sendBtn = root.querySelector(".fd-send");
    var leaveLink = root.querySelector(".fd-leave-link");
    var leadForm = root.querySelector(".fd-lead-form");
    var leadName = root.querySelector(".fd-lead-name");
    var leadContact = root.querySelector(".fd-lead-contact");
    var leadSubmit = root.querySelector(".fd-lead-submit");
    var leadCancel = root.querySelector(".fd-lead-cancel");
    var leadStatus = root.querySelector(".fd-lead-status");

    function addMessage(text, who) {
      // Bot replies get a small avatar alongside them, the way a real
      // conversation reads (you see who's talking) - user messages don't,
      // matching the reference: only the other party gets a face.
      if (who === "bot") {
        var row = document.createElement("div");
        row.className = "fd-msg-row";
        var av = document.createElement("span");
        av.className = "fd-msg-avatar";
        av.innerHTML = bubbleInner; // our own fixed avatar markup, not user/AI text
        var bubbleEl = document.createElement("div");
        bubbleEl.className = "fd-msg fd-bot";
        bubbleEl.textContent = text; // textContent only - never innerHTML with user/AI text
        row.appendChild(av);
        row.appendChild(bubbleEl);
        messages.appendChild(row);
        messages.scrollTop = messages.scrollHeight;
        return bubbleEl;
      }

      var el = document.createElement("div");
      el.className = "fd-msg fd-" + who;
      el.textContent = text; // textContent only - never innerHTML with user/AI text
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
      return el;
    }

    // Lightweight signal on answer quality - which FAQs are actually
    // landing. No backend wired up for this yet; it's a local, honest
    // acknowledgment for now (see README for the "when this matters at
    // scale" note), not a fake action.
    function addFeedback(forQuestion, answerText) {
      var el = document.createElement("div");
      el.className = "fd-feedback";
      el.innerHTML = '<span class="fd-answered-by">' + escapeHtml(theme.assistantName) + ' &middot; AI Agent</span>' +
        '<button data-v="up" type="button" aria-label="Good answer">&#128077;</button>' +
        '<button data-v="down" type="button" aria-label="Not helpful">&#128078;</button>';
      messages.appendChild(el);
      el.addEventListener("click", function (e) {
        var btn = e.target.closest("button");
        if (!btn) return;
        Array.prototype.forEach.call(el.querySelectorAll("button"), function (b) { b.classList.remove("fd-picked"); });
        btn.classList.add("fd-picked");
        console.log("[frontdesk feedback]", btn.getAttribute("data-v"), { question: forQuestion, answer: answerText });
      });
      messages.scrollTop = messages.scrollHeight;
    }

    function showTyping() {
      var el = document.createElement("div");
      el.className = "fd-typing";
      el.innerHTML = "<span></span><span></span><span></span>";
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
      return el;
    }

    // Kept client-side only to send as context on the next turn - never
    // trusted as an access-control boundary; the server independently caps
    // input length, history length, and requests per minute.
    var history = [];

    function askBackend(text) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 8000);

      // opts.sendConfigInline is set for the "Make Your AI Receptionist"
      // self-serve tool: there's no reviewed file behind that businessKey,
      // so the current live config travels with the request instead. The
      // backend independently sanitizes/caps this - never trust that this
      // client-side object matches what actually gets used server-side.
      var body = { businessKey: instanceKey, message: text, history: history };
      if (opts.sendConfigInline) body.previewConfig = config;

      return fetch(instanceApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body)
      })
        .then(function (r) {
          clearTimeout(timeout);
          if (!r.ok) throw new Error("bad status " + r.status);
          return r.json();
        })
        .then(function (data) { return data.reply; });
    }

    function send() {
      var text = input.value.trim();
      if (!text) return;
      addMessage(text, "user");
      input.value = "";
      input.disabled = true;
      sendBtn.disabled = true;

      var typingEl = showTyping();

      function finish(replyText) {
        typingEl.remove();
        addMessage(replyText, "bot");
        addFeedback(text, replyText);
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: replyText });
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }

      if (instanceApiUrl) {
        askBackend(text).then(finish).catch(function () {
          // Backend down/slow/misconfigured - degrade to local matching
          // rather than leaving the visitor with a broken widget.
          finish(matchAnswer(config, text));
        });
      } else {
        setTimeout(function () { finish(matchAnswer(config, text)); }, 400);
      }
    }

    function setLeadFormOpen(open) {
      leadForm.classList.toggle("fd-open", open);
      leadStatus.textContent = "";
      leadStatus.className = "fd-lead-status";
      if (open) leadName.focus();
    }

    function submitLead() {
      var name = leadName.value.trim();
      var contact = leadContact.value.trim();
      if (!name || !contact) {
        leadStatus.textContent = "Please fill in both fields.";
        leadStatus.className = "fd-lead-status fd-err";
        return;
      }
      if (!instanceLeadApiUrl) {
        leadStatus.textContent = "Sorry, this demo isn't wired up to actually deliver leads yet.";
        leadStatus.className = "fd-lead-status fd-err";
        return;
      }

      leadSubmit.disabled = true;
      leadStatus.textContent = "Sending...";
      leadStatus.className = "fd-lead-status";

      fetch(instanceLeadApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessKey: instanceKey,
          name: name,
          contact: contact,
          transcript: history.slice(-6)
        })
      })
        .then(function (r) { if (!r.ok) throw new Error("bad status " + r.status); return r.json(); })
        .then(function () {
          leadSubmit.disabled = false;
          setLeadFormOpen(false);
          addMessage("Thanks " + name + " - the team has your details and will be in touch soon.", "bot");
          leadName.value = "";
          leadContact.value = "";
        })
        .catch(function () {
          leadSubmit.disabled = false;
          leadStatus.textContent = "Something went wrong sending that - please call us instead.";
          leadStatus.className = "fd-lead-status fd-err";
        });
    }

    leaveLink.addEventListener("click", function () { setLeadFormOpen(!leadForm.classList.contains("fd-open")); });
    leadCancel.addEventListener("click", function () { setLeadFormOpen(false); });
    leadSubmit.addEventListener("click", submitLead);

    var dismissed = false; // any real engagement (open or explicit close) stops the proactive stuff

    function settle() {
      dismissed = true;
      bubble.classList.add("fd-settled");
    }

    // Just the name, deliberately - no large avatar graphic here (that's
    // what the small header avatar is for; a second big one ate up too
    // much space for what it added).
    function renderHeroGreeting(text) {
      var el = document.createElement("div");
      el.className = "fd-hero";
      el.innerHTML = '<div class="fd-hero-text"></div>';
      el.querySelector(".fd-hero-text").textContent = text; // textContent only, same rule as addMessage
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    }

    var greeted = false;
    function showGreeting() {
      if (greeted) return;
      greeted = true;
      var openNow = isOpenNow(config);
      var greeting = (openNow === false && config.afterHoursGreeting)
        ? config.afterHoursGreeting
        : (config.greeting || "Hi! How can I help you today?");
      // Short, bold hero line first (the actual "moment"), then the fuller
      // informational greeting as a normal message below it - existing
      // configs already write greeting as a helpful paragraph, which reads
      // badly blown up to headline size. This way nothing in configs.json
      // needs rewriting to get the better opening moment.
      renderHeroGreeting("Hi! I'm " + theme.assistantName + " 👋");
      addMessage(greeting, "bot");
      // Both of the above auto-scroll to the bottom as they're appended,
      // which would scroll straight past the hero the instant the second
      // message lands - defeating the point of it. Show from the top for
      // this opening moment instead; normal back-and-forth after this
      // still scrolls to bottom as expected.
      messages.scrollTop = 0;
      if (openNow === false) {
        root.querySelector(".fd-sub").textContent = "Currently closed - I can still help";
      }
    }

    bubble.addEventListener("click", function () {
      settle();
      var open = panel.classList.toggle("fd-open");
      if (open) showGreeting();
    });

    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      settle();
      panel.classList.remove("fd-open");
    });

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") send();
    });


    // Proactively open with the real greeting after a short delay, instead
    // of relying on the bubble alone or a small teaser tooltip to catch the
    // eye. Checked how Intercom's own site behaves for this: their launcher
    // icon is actually smaller than ours (48px), but they auto-open the
    // full greeting card within ~2 seconds of page load - the invitation
    // itself is what gets noticed, not bubble motion. Never fires if the
    // visitor's already engaged (opened or explicitly closed it first).
    var autoOpenTimer = setTimeout(function () {
      if (dismissed || panel.classList.contains("fd-open")) return;
      settle();
      panel.classList.add("fd-open");
      showGreeting();
    }, 2500);

    // Auto-open and greet immediately when explicitly asked to (used by the
    // "try it for your business" live preview, where a visitor just filled
    // in a form and shouldn't have to also find and click a bubble to see
    // the result).
    if (opts.autoOpen) {
      bubble.click();
    }

    return {
      destroy: function () {
        clearTimeout(autoOpenTimer);
        host.remove();
      }
    };
  }

  // Public API so a page can mount an independent, dynamically-configured
  // instance (e.g. a live "preview your business" tool) alongside, or
  // instead of, the auto-init-from-script-tag instance below. Deliberately
  // does NOT accept an apiUrl/leadApiUrl from the caller by default - a
  // programmatically-built config from arbitrary page input should run on
  // the safe local keyword-matcher, not be wired to a live AI backend,
  // unless a caller explicitly opts in.
  window.FrontdeskWidget = {
    autoInstance: null, // the script-tag-driven instance, if any - see start()
    mount: function (config, opts) {
      return init(config, opts || {});
    }
  };

  function start() {
    if (!configUrl) {
      console.error("[frontdesk-widget] missing data-config-url attribute");
      return;
    }
    fetch(configUrl)
      .then(function (r) { return r.json(); })
      .then(function (config) {
        window.FrontdeskWidget.autoInstance = init(config, {});
      })
      .catch(function (err) {
        console.error("[frontdesk-widget] failed to load config", err);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
