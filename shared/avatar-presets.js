/**
 * The 6 preset AI-receptionist avatars offered in the "Make your AI
 * receptionist" self-serve tool. Lives here (not inline in site/index.html)
 * so the browser tool and the server-side Stripe webhook build the exact
 * same avatar from the exact same source - a paid signup only ever carries
 * a short avatarPresetId through Stripe metadata, and the server resolves
 * it back to one of these known SVGs, never an arbitrary attacker-supplied
 * data URI.
 *
 * A small illustrated set, not real photos - "human receptionist, robot,
 * or something fun," kept in the same honestly-not-a-real-person style as
 * the widget's own default face rather than stock photos of actual people.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FrontdeskAvatarPresets = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  var PRESETS = [
    { id: "coral", svg: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffb37a"/><stop offset="100%" stop-color="#ff7a59"/></linearGradient></defs><circle cx="20" cy="20" r="19" fill="url(#a1)"/><circle cx="14" cy="19" r="2.3" fill="#3a1f14"/><circle cx="26" cy="19" r="2.3" fill="#3a1f14"/><path d="M13 25 Q20 30.5 27 25" stroke="#3a1f14" stroke-width="2.3" fill="none" stroke-linecap="round"/></svg>' },
    { id: "sky", svg: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8fd8ff"/><stop offset="100%" stop-color="#2f8fe0"/></linearGradient></defs><circle cx="20" cy="20" r="19" fill="url(#a2)"/><circle cx="14" cy="19" r="2.3" fill="#0b2a45"/><circle cx="26" cy="19" r="2.3" fill="#0b2a45"/><path d="M13 25 Q20 30.5 27 25" stroke="#0b2a45" stroke-width="2.3" fill="none" stroke-linecap="round"/></svg>' },
    { id: "violet", svg: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#d3b6ff"/><stop offset="100%" stop-color="#8b5cf6"/></linearGradient></defs><circle cx="20" cy="20" r="19" fill="url(#a3)"/><circle cx="14" cy="19" r="2.3" fill="#2c1a4d"/><circle cx="26" cy="19" r="2.3" fill="#2c1a4d"/><path d="M13 25 Q20 30.5 27 25" stroke="#2c1a4d" stroke-width="2.3" fill="none" stroke-linecap="round"/></svg>' },
    { id: "robot-silver", svg: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a4" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#dde2e8"/><stop offset="100%" stop-color="#9aa4b2"/></linearGradient></defs><circle cx="20" cy="6" r="2" fill="#9aa4b2"/><rect x="1" y="8" width="38" height="31" rx="12" fill="url(#a4)"/><rect x="11" y="18" width="6" height="4" rx="1.5" fill="#1a2230"/><rect x="23" y="18" width="6" height="4" rx="1.5" fill="#1a2230"/><rect x="14" y="27" width="12" height="2.5" rx="1.25" fill="#1a2230"/></svg>' },
    { id: "robot-teal", svg: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a5" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7fe0d8"/><stop offset="100%" stop-color="#1f9fa3"/></linearGradient></defs><circle cx="20" cy="6" r="2" fill="#1f9fa3"/><rect x="1" y="8" width="38" height="31" rx="15" fill="url(#a5)"/><circle cx="14" cy="21" r="3" fill="#0b3030"/><circle cx="26" cy="21" r="3" fill="#0b3030"/><path d="M14 28 Q20 31 26 28" stroke="#0b3030" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' },
    { id: "star", svg: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a6" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffe27a"/><stop offset="100%" stop-color="#ffb020"/></linearGradient></defs><path d="M20 2 L24.5 14.5 L38 15 L27 23 L31 36 L20 28 L9 36 L13 23 L2 15 L15.5 14.5 Z" fill="url(#a6)"/><circle cx="16" cy="20" r="2" fill="#5c3a00"/><circle cx="24" cy="20" r="2" fill="#5c3a00"/><path d="M15 25 Q20 28.5 25 25" stroke="#5c3a00" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' }
  ];

  function svgToDataUri(svg) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  function findPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return null;
  }

  return { PRESETS: PRESETS, svgToDataUri: svgToDataUri, findPreset: findPreset };
});
