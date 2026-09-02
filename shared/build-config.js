/**
 * The one place that turns "a business's answers to the self-serve form"
 * into an actual Frontdesk config object. Used from two places that must
 * never drift apart: the browser (the free "Make your AI receptionist"
 * live preview) and the Stripe webhook (turning a paid signup's draft
 * metadata into the real, committed configs/{key}.json). Deliberately pure
 * - no DOM access, no network calls - so both callers get identical output
 * for identical input.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./avatar-presets"));
  } else {
    root.FrontdeskBuildConfig = factory(root.FrontdeskAvatarPresets);
  }
})(typeof self !== "undefined" ? self : this, function (avatarPresets) {
  var GREETINGS = {
    appointments: "Hi! Welcome to {name}. Ask me about appointments, treatments, or opening times - or leave your details and we'll call you back.",
    callouts: "Hi! Welcome to {name}. Ask about call-outs, pricing, or coverage area - or leave your details for a callback.",
    viewings: "Hi! Welcome to {name}. Ask about viewings, valuations, or current listings - or leave your details and we'll be in touch.",
    general: "Hi! Welcome to {name}. Ask me anything, or leave your details and the team will get back to you."
  };

  // Node only (no `process` in a browser) - matches the fallback used
  // elsewhere (api/create-checkout.js etc) so a resolved avatar URL always
  // points at wherever this is actually deployed.
  function siteBaseUrl() {
    if (typeof process !== "undefined" && process.env && process.env.SITE_BASE_URL) return process.env.SITE_BASE_URL;
    return "https://frontdesk-ai-chi-ten.vercel.app";
  }

  // input: { businessName, agentName, type, phone, color, extraInfo,
  //          avatarDataUri?, avatarId?, avatarPresetId? }
  // avatarDataUri (a full data URI, possibly a large custom-uploaded photo)
  // is only ever safe to trust from the free, client-side-only preview path.
  // avatarId is a short reference to an image already uploaded via
  // api/upload-avatar.js and committed to the repo - the only avatar path
  // that actually survives into a paid signup, since Stripe metadata can't
  // carry a full image. avatarPresetId (one of the 6 built-in faces) still
  // works too, kept for backwards compatibility with anything already using it.
  function buildFrontdeskConfig(input) {
    input = input || {};
    var name = (input.businessName || "Your Business").toString().trim().slice(0, 80) || "Your Business";
    var agentName = (input.agentName || "Ivy").toString().trim().slice(0, 40) || "Ivy";
    var type = GREETINGS[input.type] ? input.type : "general";
    var phone = (input.phone || "your number").toString().trim().slice(0, 40) || "your number";
    var color = (input.color || "#2f8fe0").toString().slice(0, 10);
    var extraInfo = (input.extraInfo || "").toString().trim().slice(0, 1000);

    var avatarUrl;
    if (input.avatarDataUri) {
      avatarUrl = input.avatarDataUri;
    } else if (input.avatarId && /^[0-9a-f]{24}\.(png|jpg|webp|gif)$/i.test(input.avatarId)) {
      avatarUrl = siteBaseUrl() + "/configs/avatars/" + input.avatarId;
    } else if (input.avatarPresetId) {
      var preset = avatarPresets.findPreset(input.avatarPresetId);
      if (preset) avatarUrl = avatarPresets.svgToDataUri(preset.svg);
    }

    var faqs = [
      { keywords: ["hour", "open", "close", "time"], answer: "For exact hours it's best to call " + phone + " - the team can confirm and fit you in." },
      { keywords: ["price", "cost", "how much", "quote"], answer: "Pricing depends on what you need - call " + phone + " or leave your details for a quote." },
      { keywords: ["book", "appointment", "callout", "viewing", "available"], answer: "You can book by calling " + phone + ", or leave your details here and we'll be in touch." },
      { keywords: ["where", "location", "address"], answer: "Give us a call on " + phone + " for directions and parking info." }
    ];
    if (extraInfo) faqs.unshift({ keywords: [], answer: extraInfo });

    return {
      businessName: name,
      theme: { accentColor: color, position: "right", assistantName: agentName, avatarUrl: avatarUrl },
      greeting: GREETINGS[type].replace("{name}", name),
      fallbackAnswer: "I'll pass that on to the team - would you like to leave your name and number, or call " + phone + "?",
      faqs: faqs
    };
  }

  return { buildFrontdeskConfig: buildFrontdeskConfig, GREETINGS: GREETINGS };
});
