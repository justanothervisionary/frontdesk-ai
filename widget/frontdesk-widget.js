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
      // This is a <button>, so it inherits the browser's own default
      // padding unless reset here - that leftover padding was the actual
      // cause of the accent-color ring around the avatar (the image was
      // correctly filling 100% of the button's content box, just that
      // content box was smaller than the full circle because of the
      // unreset padding around it), not the border-radius double-clip
      // fixed in the previous pass - that fix was real but wasn't the
      // whole story.
      "  padding: 0; box-shadow: 0 4px 16px rgba(0,0,0,.2); cursor: pointer; z-index: 999999; border: none;" +
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
      // photo looking tiny with empty space around it. No border-radius
      // on the img itself - .fd-bubble already clips to a circle via its
      // own border-radius + overflow:hidden, and applying it twice (once
      // here, once on the parent) left a thin sliver of the accent-color
      // background visible where the two independently-rounded edges
      // didn't perfectly align.
      ".fd-bubble svg, .fd-bubble img { width: 100%; height: 100%; display: block; }" +
      ".fd-bubble img { object-fit: cover; }" +
      // The proactive moment "hangs back" instead of springing the full
      // panel open on every visitor: a small card near the launcher with
      // just a short greeting, not the whole conversation UI. Clicking it
      // opens the real panel; the small close button dismisses it on its
      // own without forcing that.
      ".fd-teaser {" +
      "  position: fixed; " + side + ": " + offset + "; bottom: calc(" + offset + " + 74px); max-width: 220px;" +
      "  background: #fff; border-radius: 16px; padding: 12px 30px 12px 12px;" +
      "  box-shadow: 0 12px 32px rgba(0,0,0,.2); cursor: pointer; z-index: 999999; display: none;" +
      "  animation: fd-pop-in .35s cubic-bezier(.34,1.56,.64,1);" +
      "}" +
      ".fd-teaser.fd-show { display: block; }" +
      ".fd-teaser-inner { display: flex; align-items: center; gap: 9px; }" +
      ".fd-teaser-avatar { width: 30px; height: 30px; border-radius: 50%; overflow: hidden; flex-shrink: 0; display: block; }" +
      ".fd-teaser-avatar svg, .fd-teaser-avatar img { width: 100%; height: 100%; display: block; object-fit: cover; }" +
      ".fd-teaser-text { font-size: 13px; font-weight: 600; line-height: 1.35; color: #1a1a1a; }" +
      ".fd-teaser-close {" +
      "  position: absolute; top: 8px; " + other + ": 8px; width: 18px; height: 18px; border-radius: 50%;" +
      "  border: none; background: #f0f1f3; color: #8a8f99; cursor: pointer; font-size: 10px;" +
      "  display: flex; align-items: center; justify-content: center; line-height: 1; padding: 0;" +
      "}" +
      ".fd-teaser-close:hover { background: #e5e7eb; }" +
      ".fd-panel {" +
      "  position: fixed; " + side + ": " + offset + "; bottom: calc(" + offset + " + 70px); width: 368px; max-width: calc(100vw - 32px);" +
      "  height: 500px; max-height: calc(100vh - 140px); border-radius: 22px;" +
      "  box-shadow: 0 20px 56px rgba(0,0,0,.28); display: none; flex-direction: column;" +
      "  overflow: visible; z-index: 999999;" +
      "  animation: fd-pop-in .32s cubic-bezier(.34,1.56,.64,1);" +
      "}" +
      ".fd-panel-inner { display: flex; flex-direction: column; height: 100%; border-radius: 22px; overflow: hidden; background: #fff; }" +
      ".fd-panel.fd-open { display: flex; }" +
      // Kept flat and neutral on purpose - black, not the business's own
      // accent color. An accent-colored header reads as "banner ad"; a
      // plain dark one reads as a real product surface, and it's what
      // most comparable chat widgets (Intercom, Crisp, Drift) actually
      // do - the accent color is reserved for buttons and the visitor's
      // own message bubbles instead, where it still gives the panel a
      // branded feel without dominating the first thing a visitor sees.
      ".fd-header {" +
      "  background: #0a0b0d;" +
      "  color: #fff; padding: 18px 18px 20px; display: flex; align-items: center; gap: 12px; position: relative;" +
      "}" +
      ".fd-header img, .fd-face-sm { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex-shrink: 0; display: block; box-shadow: 0 2px 8px rgba(0,0,0,.2); }" +
      ".fd-face-sm svg { width: 100%; height: 100%; display: block; }" +
      ".fd-header-avatar-wrap { position: relative; flex-shrink: 0; display: block; }" +
      // Same brand green as the site favicon's pulse dot - a small,
      // deliberate consistency touch, not just "a green dot".
      ".fd-online-dot {" +
      "  position: absolute; bottom: -1px; right: -1px; width: 11px; height: 11px; border-radius: 50%;" +
      "  background: #35d68f; border: 2px solid #0a0b0d; box-sizing: content-box;" +
      "}" +
      ".fd-bubble { overflow: hidden; }" +
      // min-width: 0 is what actually lets a flex child shrink below its
      // content size - without it, text-overflow:ellipsis on the children
      // below has no effect and a long business name just wraps to a
      // second line instead, eating into the panel's already-tight height.
      ".fd-header-text { flex: 1; min-width: 0; }" +
      ".fd-header .fd-name { font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }" +
      ".fd-header .fd-sub { font-size: 12px; opacity: .9; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }" +
      ".fd-close {" +
      "  position: absolute; top: 12px; right: 12px; width: 24px; height: 24px; border-radius: 50%;" +
      "  border: none; background: rgba(255,255,255,.22); color: inherit; cursor: pointer; font-size: 15px;" +
      "  display: flex; align-items: center; justify-content: center; line-height: 1; padding: 0;" +
      "}" +
      ".fd-close:hover { background: rgba(255,255,255,.34); }" +
      // A small face next to each bot reply reads as a real conversation
      // rather than a wall of unattributed text - the same avatar used in
      // the header, just small. User's own messages don't get one,
      // matching how most chat UIs only attribute the OTHER party.
      ".fd-msg-row { display: flex; align-items: flex-end; gap: 8px; margin-bottom: 8px; }" +
      ".fd-msg-row .fd-msg { margin-bottom: 0; }" +
      ".fd-msg-avatar { width: 24px; height: 24px; border-radius: 50%; overflow: hidden; flex-shrink: 0; display: block; }" +
      ".fd-msg-avatar svg, .fd-msg-avatar img { width: 100%; height: 100%; display: block; object-fit: cover; }" +
      ".fd-messages { flex: 1; overflow-y: auto; padding: 12px; background: #f7f8fa; }" +
      // Flat, uniform rounded rectangles - no border, no asymmetric
      // "speech-tail" corner-clip. That corner notch was a nice idea in
      // theory but reads as a rendering glitch at a glance; a plain
      // rounded bubble is calmer and matches what most comparable widgets
      // actually ship.
      ".fd-msg { max-width: 85%; margin-bottom: 8px; padding: 9px 13px; border-radius: 14px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; animation: fd-msg-in .18s ease-out; }" +
      "@keyframes fd-msg-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }" +
      ".fd-msg.fd-bot { background: #eef0f3; }" +
      ".fd-msg.fd-user { background: var(--fd-accent, #ff7a59); color: var(--fd-on-accent, #fff); margin-" + other + ": auto; }" +
      // Just two quiet thumbs, right-aligned under the bubble - no "Serena
      // - AI Agent" label (the header already says who you're talking to,
      // repeating it under every single message was the actual clutter).
      // Near-invisible until hover so it doesn't compete with the message
      // itself, which is the point of it being feedback, not a UI element.
      ".fd-feedback { display: flex; justify-content: flex-end; gap: 2px; margin: -4px 2px 8px; }" +
      ".fd-feedback button { border: none; background: none; cursor: pointer; font-size: 12px; opacity: .25; padding: 2px 4px; }" +
      ".fd-feedback button:hover { opacity: .7; }" +
      ".fd-feedback button.fd-picked { opacity: 1; }" +
      ".fd-inputrow { display: flex; align-items: center; border-top: 1px solid #eee; padding: 8px; gap: 4px; position: relative; }" +
      ".fd-input { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; min-width: 0; }" +
      // Icon-only, quiet - sits next to the send button but shouldn't
      // compete with it for attention.
      ".fd-emoji-btn {" +
      "  border: none; background: none; color: #8a8f99; font-size: 17px; cursor: pointer;" +
      "  width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" +
      "}" +
      ".fd-emoji-btn:hover { background: #f0f1f3; }" +
      ".fd-attach-btn {" +
      "  border: none; background: none; color: #8a8f99; cursor: pointer;" +
      "  width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" +
      "}" +
      ".fd-attach-btn:hover { background: #f0f1f3; }" +
      ".fd-attach-btn svg { width: 17px; height: 17px; display: block; }" +
      // One row of small chips, each file/upload its own pill - sits
      // above the input row, inside the same bordered area rather than
      // floating, so it reads as "attached to what you're about to send".
      ".fd-attach-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 8px 0; }" +
      ".fd-attach-chips:empty { display: none; padding: 0; }" +
      ".fd-attach-chip {" +
      "  display: inline-flex; align-items: center; gap: 5px; max-width: 160px; background: #f0f1f3; border-radius: 999px;" +
      "  padding: 4px 6px 4px 10px; font-size: 11px; color: #444;" +
      "}" +
      ".fd-attach-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" +
      ".fd-attach-chip.fd-err { background: #fdeceb; color: #a33; }" +
      ".fd-attach-chip-remove {" +
      "  border: none; background: none; color: inherit; opacity: .6; cursor: pointer; font-size: 10px; padding: 2px; line-height: 1;" +
      "  width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;" +
      "}" +
      ".fd-attach-chip-remove:hover { opacity: 1; }" +
      "@keyframes fd-spin { to { transform: rotate(360deg); } }" +
      ".fd-attach-chip-spinner {" +
      "  width: 10px; height: 10px; border-radius: 50%; border: 2px solid #c6c9cf; border-top-color: #777;" +
      "  animation: fd-spin .7s linear infinite; flex-shrink: 0;" +
      "}" +
      ".fd-emoji-popover {" +
      "  display: none; position: absolute; bottom: calc(100% + 6px); right: 8px; background: #fff; border: 1px solid #e5e7eb;" +
      "  border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 8px; z-index: 2;" +
      "  grid-template-columns: repeat(6, 1fr); gap: 2px;" +
      "}" +
      ".fd-emoji-popover.fd-show { display: grid; }" +
      ".fd-emoji-popover button {" +
      "  border: none; background: none; font-size: 18px; cursor: pointer; width: 30px; height: 30px; border-radius: 6px; padding: 0;" +
      "}" +
      ".fd-emoji-popover button:hover { background: #f0f1f3; }" +
      // Round, filled, icon-only - the "nice arrow to send" reference.
      // Same accent color as the visitor's own message bubbles, so it
      // reads as the same system rather than a mismatched extra color.
      ".fd-send {" +
      "  background: var(--fd-accent, #ff7a59); color: var(--fd-on-accent, #fff); border: none; border-radius: 50%;" +
      "  width: 34px; height: 34px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; cursor: pointer;" +
      "}" +
      ".fd-send svg { width: 16px; height: 16px; display: block; }" +
      // The callback request, restyled as a quiet pill rather than a
      // full-width underlined link - still a real lead-capture path for
      // a visitor who'd rather not type a question, just not shouting
      // about it underneath every conversation.
      ".fd-leave-link {" +
      "  display: inline-flex; align-items: center; gap: 5px; margin: 8px 12px 0; border: 1px solid #e5e7eb; background: #fff;" +
      "  color: #555; font-size: 11px; font-weight: 600; border-radius: 999px; cursor: pointer; padding: 5px 12px 5px 9px;" +
      "}" +
      ".fd-leave-link:hover { background: #f7f8fa; }" +
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
      ".fd-typing { display: flex; gap: 3px; padding: 10px 12px; }" +
      ".fd-typing span { width: 6px; height: 6px; border-radius: 50%; background: #bbb; animation: fd-bounce 1.2s infinite; }" +
      ".fd-typing span:nth-child(2) { animation-delay: .15s; }" +
      ".fd-typing span:nth-child(3) { animation-delay: .3s; }" +
      "@keyframes fd-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }" +
      "@media (max-width: 480px) {" +
      "  .fd-panel { right: 8px; left: 8px; width: auto; bottom: 84px; height: 70vh; max-height: 70vh; }" +
      "  .fd-bubble { " + side + ": 14px; bottom: 14px; }" +
      "  .fd-teaser { " + side + ": 14px; bottom: 82px; max-width: calc(100vw - 100px); }" +
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

  // A soft two-note chime for the teaser's first appearance - synthesized
  // (Web Audio, no audio file to host) rather than a per-message ding, so
  // it only ever plays once, the moment a visitor is first proactively
  // greeted, not on every open. Best-effort only: browsers block audio
  // until the visitor has interacted with the page at least once
  // (autoplay policy), so on a cold landing this may play silently - the
  // teaser card itself still always appears regardless.
  function playGreetingTone() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      [880, 1318.5].forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        var start = ctx.currentTime + i * 0.09;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.05, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.4);
      });
    } catch (e) { /* Web Audio unavailable or blocked - the teaser card itself is unaffected */ }
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
  var DEFAULT_AVATAR_URL = "https://frontdesk-ai-chi-ten.vercel.app/site/assets/images/sia-avatar.jpg";

  // A small hardcoded set rather than a third-party emoji-picker library -
  // keeps this a single, dependency-free file (no new network request, no
  // bundle size hit) while still covering what a visitor actually reaches
  // for in a short business chat.
  var EMOJI_SET = ["😊", "👍", "🙂", "😂", "❤️", "🎉", "👋", "😅", "🤔", "👌", "😍", "👏", "✅", "😢", "🙏", "👀", "💡", "😮"];

  // A paper-plane send icon, matching the "circular arrow button" look of
  // most comparable chat widgets - an inline SVG so it stays crisp at any
  // size and needs no icon font/library.
  var SEND_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 11.5L20.5 3.5L13.5 21L10.8 13.9L3 11.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  var ATTACH_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.5 7.5L8.6 16.4a3 3 0 0 1-4.2-4.2l9-9a2 2 0 0 1 2.9 2.8l-8.6 8.6a1 1 0 0 1-1.4-1.4l7.9-7.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Must match api/_lib/attachments.js's own allowlist - this is just the
  // file picker's filter (a visitor can still override it in most OS file
  // dialogs), the server re-validates the real content type regardless.
  var ATTACH_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
  var ATTACH_MAX_BYTES = 6 * 1024 * 1024;

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
      assistantName: t.assistantName || config.assistantName || "Sia",
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
    // Some sites' CSS resets hide any element matching :empty (e.g.
    // Shopify's base.css). The host has no light-DOM children - everything
    // lives in its shadow root - so it matches :empty and gets display:none
    // even though the shadow content itself renders fine. An inline style
    // beats an external stylesheet rule without !important, so this holds
    // regardless of what a given site's CSS does.
    host.style.display = "block";
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
      '<div class="fd-teaser" role="button" tabindex="0">' +
      '<button class="fd-teaser-close" type="button" aria-label="Dismiss">&#10005;</button>' +
      '<div class="fd-teaser-inner"><span class="fd-teaser-avatar">' + bubbleInner + '</span><span class="fd-teaser-text"></span></div>' +
      "</div>" +
      '<div class="fd-panel"><div class="fd-panel-inner">' +
      '<div class="fd-header"><div class="fd-header-avatar-wrap">' + headerAvatar + '<span class="fd-online-dot"></span></div>' +
      '<div class="fd-header-text"><div class="fd-name"></div><div class="fd-sub"></div></div>' +
      '<button class="fd-close" type="button" aria-label="Close chat">&#10005;</button></div>' +
      '<div class="fd-messages"></div>' +
      '<button class="fd-leave-link" type="button">&#128197; Request a callback</button>' +
      '<div class="fd-lead-form">' +
      '<input class="fd-lead-name" type="text" placeholder="Your name" />' +
      '<input class="fd-lead-contact" type="text" placeholder="Phone or email" />' +
      '<div class="fd-lead-actions">' +
      '<button class="fd-lead-submit" type="button">Send</button>' +
      '<button class="fd-lead-cancel" type="button">Cancel</button>' +
      "</div>" +
      '<div class="fd-lead-status"></div>' +
      "</div>" +
      '<div class="fd-attach-chips"></div>' +
      '<div class="fd-inputrow">' +
      '<div class="fd-emoji-popover">' + EMOJI_SET.map(function (e) { return '<button type="button">' + e + "</button>"; }).join("") + "</div>" +
      '<input class="fd-attach-input" type="file" accept="' + ATTACH_ACCEPT + '" hidden />' +
      '<input class="fd-input" type="text" placeholder="Type a question..." />' +
      '<button class="fd-attach-btn" type="button" aria-label="Attach a file">' + ATTACH_ICON_SVG + "</button>" +
      '<button class="fd-emoji-btn" type="button" aria-label="Add emoji">&#128578;</button>' +
      '<button class="fd-send" type="button" aria-label="Send">' + SEND_ICON_SVG + "</button>" +
      "</div>" +
      "</div></div>";
    shadow.appendChild(root);

    root.querySelector(".fd-name").textContent = config.businessName || "Chat with us";
    root.querySelector(".fd-sub").textContent = theme.assistantName + " · usually replies instantly";

    var bubble = root.querySelector(".fd-bubble");
    var panel = root.querySelector(".fd-panel");
    var closeBtn = root.querySelector(".fd-close");
    var teaser = root.querySelector(".fd-teaser");
    var teaserText = root.querySelector(".fd-teaser-text");
    var teaserClose = root.querySelector(".fd-teaser-close");
    var messages = root.querySelector(".fd-messages");
    var input = root.querySelector(".fd-input");
    var sendBtn = root.querySelector(".fd-send");
    var emojiBtn = root.querySelector(".fd-emoji-btn");
    var emojiPopover = root.querySelector(".fd-emoji-popover");
    var attachBtn = root.querySelector(".fd-attach-btn");
    var attachInput = root.querySelector(".fd-attach-input");
    var attachChips = root.querySelector(".fd-attach-chips");
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
      el.innerHTML = '<button data-v="up" type="button" aria-label="Good answer">&#128077;</button>' +
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
    // True once the AI has captured a lead directly from the conversation
    // (see api/chat.js's capture_lead tool) - stops the server from even
    // offering the tool again this conversation, and hides the now-
    // redundant manual "leave your details" link below.
    var leadAlreadyCaptured = false;

    // Every file ever attached this conversation, kept around (not cleared
    // after each send) so a lead captured several turns after a photo was
    // attached still includes it. Each entry: { id, name, status: 'uploading'
    // | 'done' | 'error', url }. Capped at 3 - plenty for "here's a photo of
    // the issue", not an open-ended upload queue.
    var attachments = [];
    var ATTACH_LIMIT = 3;

    function doneAttachmentPayload() {
      return attachments.filter(function (a) { return a.status === "done"; }).map(function (a) { return { url: a.url, name: a.name }; });
    }

    function renderAttachChips() {
      attachChips.innerHTML = "";
      attachments.forEach(function (a) {
        var chip = document.createElement("span");
        chip.className = "fd-attach-chip" + (a.status === "error" ? " fd-err" : "");
        var nameEl = document.createElement("span");
        nameEl.className = "fd-attach-chip-name";
        nameEl.textContent = a.status === "error" ? a.name + " - failed" : a.name;
        chip.appendChild(nameEl);
        if (a.status === "uploading") {
          var spinner = document.createElement("span");
          spinner.className = "fd-attach-chip-spinner";
          chip.appendChild(spinner);
        }
        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "fd-attach-chip-remove";
        removeBtn.setAttribute("aria-label", "Remove " + a.name);
        removeBtn.innerHTML = "&#10005;";
        removeBtn.addEventListener("click", function () {
          attachments = attachments.filter(function (x) { return x.id !== a.id; });
          renderAttachChips();
        });
        chip.appendChild(removeBtn);
        attachChips.appendChild(chip);
      });
    }

    function uploadAttachment(file) {
      var id = Math.random().toString(36).slice(2);
      var entry = { id: id, name: file.name, status: "uploading", url: null };
      attachments.push(entry);
      renderAttachChips();

      if (!instanceLeadApiUrl) {
        entry.status = "error";
        entry.name = file.name + " (not available in this preview)";
        renderAttachChips();
        return;
      }
      if (file.size > ATTACH_MAX_BYTES) {
        entry.status = "error";
        renderAttachChips();
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        fetch(instanceLeadApiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "upload-attachment",
            businessKey: instanceKey,
            filename: file.name,
            dataUri: reader.result
          })
        })
          .then(function (r) { if (!r.ok) throw new Error("bad status " + r.status); return r.json(); })
          .then(function (data) {
            entry.status = "done";
            entry.url = data.url;
            entry.name = data.name || file.name;
            renderAttachChips();
          })
          .catch(function () {
            entry.status = "error";
            renderAttachChips();
          });
      };
      reader.onerror = function () {
        entry.status = "error";
        renderAttachChips();
      };
      reader.readAsDataURL(file);
    }

    attachBtn.addEventListener("click", function () {
      if (attachments.length >= ATTACH_LIMIT) return;
      attachInput.click();
    });
    attachInput.addEventListener("change", function () {
      Array.prototype.forEach.call(attachInput.files || [], function (file) {
        if (attachments.length >= ATTACH_LIMIT) return;
        uploadAttachment(file);
      });
      attachInput.value = ""; // lets the same file be re-selected after a remove
    });

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
      if (leadAlreadyCaptured) body.leadAlreadyCaptured = true;
      var pendingAttachments = doneAttachmentPayload();
      if (pendingAttachments.length) body.attachments = pendingAttachments;

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
        .then(function (data) { return { reply: data.reply, leadCaptured: !!data.leadCaptured }; });
    }

    function send() {
      var text = input.value.trim();
      if (!text) return;
      addMessage(text, "user");
      input.value = "";
      input.disabled = true;
      sendBtn.disabled = true;

      var typingEl = showTyping();

      function finish(replyText, leadCaptured) {
        typingEl.remove();
        addMessage(replyText, "bot");
        addFeedback(text, replyText);
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: replyText });
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();

        if (leadCaptured && !leadAlreadyCaptured) {
          leadAlreadyCaptured = true;
          setLeadFormOpen(false);
          leaveLink.style.display = "none";
        }
      }

      if (instanceApiUrl) {
        askBackend(text).then(function (result) {
          finish(result.reply, result.leadCaptured);
        }).catch(function () {
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
          transcript: history.slice(-6),
          attachments: doneAttachmentPayload()
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

    var greeted = false;
    function showGreeting() {
      if (greeted) return;
      greeted = true;
      var openNow = isOpenNow(config);
      var greeting = (openNow === false && config.afterHoursGreeting)
        ? config.afterHoursGreeting
        : (config.greeting || "Hi! How can I help you today?");
      // The header already carries the assistant's name and identity, so
      // this one message is the conversation's only greeting - no separate
      // hero line duplicating "Hi, I'm ___" above it.
      addMessage(greeting, "bot");
    }

    function hideTeaser() {
      teaser.classList.remove("fd-show");
    }

    bubble.addEventListener("click", function () {
      hideTeaser();
      settle();
      var open = panel.classList.toggle("fd-open");
      if (open) showGreeting();
    });

    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      settle();
      panel.classList.remove("fd-open");
    });

    // Clicking the teaser itself opens the real panel, same as the bubble -
    // it's an invitation into the same conversation, not a separate thing.
    teaser.addEventListener("click", function () { bubble.click(); });
    teaserClose.addEventListener("click", function (e) {
      e.stopPropagation();
      hideTeaser();
      settle(); // an explicit dismissal - stop the idle pulse too, same as any other real engagement
    });

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") send();
    });

    emojiBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      emojiPopover.classList.toggle("fd-show");
    });
    emojiPopover.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      // Insert at the cursor position, not just appended - a visitor
      // picking an emoji mid-sentence expects it to land where they were
      // typing, not get shoved to the end.
      var start = input.selectionStart == null ? input.value.length : input.selectionStart;
      var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      input.value = input.value.slice(0, start) + btn.textContent + input.value.slice(end);
      input.focus();
      input.selectionStart = input.selectionEnd = start + btn.textContent.length;
      emojiPopover.classList.remove("fd-show");
    });
    // Listens on our own root rather than document - keeps every event
    // binding self-contained inside the shadow tree, matching the rest
    // of this file, rather than reaching out to the host page's document.
    root.addEventListener("click", function (e) {
      if (emojiPopover.classList.contains("fd-show") && !emojiPopover.contains(e.target) && e.target !== emojiBtn) {
        emojiPopover.classList.remove("fd-show");
      }
    });

    // The chime can only actually play once the browser considers the
    // visitor to have interacted with the page at all (autoplay policy) -
    // there's no way around that in any browser. If the teaser appears
    // before any interaction has happened, this defers the tone to
    // whatever the visitor's first click/tap/keypress on the page turns
    // out to be, rather than leaving it permanently silent for that visit.
    var greetingToneState = { played: false, teaserShown: false };
    function maybePlayGreetingTone() {
      if (greetingToneState.played || !greetingToneState.teaserShown) return;
      greetingToneState.played = true;
      playGreetingTone();
      ["click", "touchstart", "keydown"].forEach(function (evt) {
        document.removeEventListener(evt, maybePlayGreetingTone, true);
      });
    }
    ["click", "touchstart", "keydown"].forEach(function (evt) {
      document.addEventListener(evt, maybePlayGreetingTone, true);
    });

    // Proactively catch the eye after a short delay, but "hang back" rather
    // than springing the full conversation panel open on every visitor -
    // just a small card near the launcher with a short greeting. Clicking
    // it (or the launcher itself) opens the real panel with the full
    // greeting; dismissing it just stops there instead of forcing the
    // whole widget into view. Never fires if the visitor's already engaged.
    var autoOpenTimer = setTimeout(function () {
      if (dismissed || panel.classList.contains("fd-open")) return;
      teaserText.textContent = "Hi! I'm " + theme.assistantName + " 👋 How can I help?";
      teaser.classList.add("fd-show");
      greetingToneState.teaserShown = true;
      maybePlayGreetingTone(); // plays immediately if the page already had an interaction before now
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
