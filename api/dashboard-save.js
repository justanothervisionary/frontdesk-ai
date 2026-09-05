// Vercel serverless function - session-protected, Origin-checked. Lets a
// business edit a deliberately narrow slice of their own config (see the
// README/plan for why: domain and theme.accentColor/avatarUrl are
// excluded from self-edit in v1 - a typo in `domain` silently breaks the
// widget on their own site with no in-dashboard feedback, and avatar
// editing belongs with api/upload-avatar.js, not new upload UI here).
//
// The one rule this file exists to enforce: `active`, `stripeCustomerId`,
// `stripeSubscriptionId`, and `stripeCheckoutSessionId` are webhook-owned
// and must NEVER be settable from this endpoint's input. This matters
// because api/_lib/config.js's sanitizeCommittedConfig() returns a brand
// NEW object literal - it does not carry those fields through - so a
// naive "sanitize the submission and write it" implementation would
// silently wipe a business's Stripe linkage on their very first save.
// This avoids that entirely by only ever touching the specific allowed
// keys on a copy of the EXISTING live config, never replacing the object.
const { loadConfigLive, isEmailShaped } = require("./_lib/config");
const { getSessionBusinessKey } = require("./_lib/session");
const { isTrustedOrigin } = require("./_lib/cors");
const { putFile } = require("./_lib/github");

function sanitizeFaqs(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 8).map(function (f) {
    return {
      keywords: Array.isArray(f && f.keywords) ? f.keywords.slice(0, 10).map(function (k) { return String(k).slice(0, 30); }) : [],
      answer: ((f && f.answer) || "").toString().slice(0, 1000)
    };
  }).filter(function (f) { return f.answer.trim(); });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isTrustedOrigin(req)) return res.status(403).json({ error: "Forbidden" });

  var businessKey = getSessionBusinessKey(req);
  if (!businessKey) return res.status(401).json({ error: "Not logged in" });

  var result = await loadConfigLive(businessKey);
  if (!result) return res.status(404).json({ error: "Business not found" });

  var body = req.body || {};
  var config = result.config; // mutated in place below, then written back whole - never rebuilt from scratch

  if (typeof body.greeting === "string") {
    config.greeting = body.greeting.trim().slice(0, 300) || config.greeting;
  }
  if (typeof body.fallbackAnswer === "string") {
    config.fallbackAnswer = body.fallbackAnswer.trim().slice(0, 300) || config.fallbackAnswer;
  }
  if (typeof body.notifyEmail === "string" && body.notifyEmail.trim()) {
    if (!isEmailShaped(body.notifyEmail.trim())) {
      return res.status(400).json({ error: "That doesn't look like a valid email address." });
    }
    config.notifyEmail = body.notifyEmail.trim();
  }
  if (typeof body.assistantName === "string" && body.assistantName.trim()) {
    config.theme = config.theme || {};
    config.theme.assistantName = body.assistantName.trim().slice(0, 40);
  }
  if (body.faqs !== undefined) {
    var faqs = sanitizeFaqs(body.faqs);
    if (faqs === null) return res.status(400).json({ error: "Invalid FAQ list." });
    config.faqs = faqs;
  }

  // notifyEmail lives in the PRIVATE file, not the public config - see
  // api/_lib/config.js's loadConfig()/loadConfigLive() for why (it's
  // served to the public internet as-is). Written separately from the
  // public config below, same split api/stripe-webhook.js already uses.
  var notifyEmailToSave = config.notifyEmail;
  delete config.notifyEmail;

  try {
    await putFile(`configs/${businessKey}.json`, config, `Dashboard update for ${businessKey}`, result.sha);
    if (notifyEmailToSave) {
      var privFile = await require("./_lib/github").getFile(`api/_private-configs/${businessKey}.json`);
      await putFile(`api/_private-configs/${businessKey}.json`, { notifyEmail: notifyEmailToSave },
        `Update contact email for ${businessKey}`, privFile && privFile.sha);
    }
  } catch (err) {
    console.error("[frontdesk dashboard-save] error:", err.message);
    if (err.conflict) {
      return res.status(409).json({ error: "This was just updated elsewhere - please refresh and try again." });
    }
    return res.status(502).json({ error: "Could not save your changes - please try again." });
  }

  config.notifyEmail = notifyEmailToSave; // restore for the response - the frontend renders this back optimistically
  return res.status(200).json({ saved: true, config: config });
};
