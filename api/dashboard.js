// Vercel serverless function - combines what were three separate
// endpoints (dashboard-data, dashboard-save, billing-portal) into one
// file, dispatched by method + ?action=. Purely a Vercel Hobby-plan
// constraint (a deployment is capped at 12 Serverless Functions - see
// api/auth.js's comment for the same reasoning). No behavior changed from
// the original three files - just merged into one, routed by
// method/action.
const Stripe = require("stripe");
const { loadConfig, loadConfigLive, listBusinessKeys, isEmailShaped, isPhoneShaped, isKnownType, isKnownAvatarUrl } = require("./_lib/config");
const { readLeads } = require("./_lib/leadLog");
const { getSessionBusinessKey, getSessionAdminEmail } = require("./_lib/session");
const { isTrustedOrigin } = require("./_lib/cors");
const { getFile, putFile } = require("./_lib/github");
const { getUsage } = require("./_lib/usage");

// Lazy, not eager - see api/create-checkout.js for why: an unset
// STRIPE_SECRET_KEY should fail one request cleanly, not crash the module.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://frontdesk-ai-chi-ten.vercel.app";

async function handleGetData(req, res, businessKey) {
  var result = await loadConfigLive(businessKey);
  if (!result) return res.status(404).json({ error: "Business not found" });

  var leadData = await readLeads(businessKey);

  return res.status(200).json({
    businessKey: businessKey,
    businessName: result.config.businessName,
    type: result.config.type || "general",
    phone: result.config.phone || "",
    domain: result.config.domain || "",
    greeting: result.config.greeting,
    fallbackAnswer: result.config.fallbackAnswer,
    faqs: result.config.faqs || [],
    notifyEmail: result.config.notifyEmail || "",
    assistantName: (result.config.theme && result.config.theme.assistantName) || "Sia",
    avatarUrl: (result.config.theme && result.config.theme.avatarUrl) || "",
    active: result.config.active !== false,
    // All leads within the 35-day retention window, not just this week's
    // slice (that narrower view is specifically for the weekly digest
    // email) - a business checking their own dashboard wants everything
    // recent, newest first.
    leads: leadData.all.slice().reverse()
  });
}

function sanitizeFaqs(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 8).map(function (f) {
    return {
      keywords: Array.isArray(f && f.keywords) ? f.keywords.slice(0, 10).map(function (k) { return String(k).slice(0, 30); }) : [],
      answer: ((f && f.answer) || "").toString().slice(0, 1000)
    };
  }).filter(function (f) { return f.answer.trim(); });
}

// The one rule this function exists to enforce: `active`, `stripeCustomerId`,
// `stripeSubscriptionId`, and `stripeCheckoutSessionId` are webhook-owned
// and must NEVER be settable from this endpoint's input. This matters
// because api/_lib/config.js's sanitizeCommittedConfig() returns a brand
// NEW object literal - it does not carry those fields through - so a
// naive "sanitize the submission and write it" implementation would
// silently wipe a business's Stripe linkage on their very first save.
// This avoids that entirely by only ever touching specific allowed keys
// on a copy of the EXISTING live config, never replacing the object.
async function handleSave(req, res, businessKey) {
  var result = await loadConfigLive(businessKey);
  if (!result) return res.status(404).json({ error: "Business not found" });

  var body = req.body || {};
  var config = result.config; // mutated in place below, then written back whole - never rebuilt from scratch

  if (typeof body.businessName === "string" && body.businessName.trim()) {
    config.businessName = body.businessName.trim().slice(0, 80);
  }
  if (typeof body.type === "string" && body.type.trim()) {
    if (!isKnownType(body.type.trim())) {
      return res.status(400).json({ error: "That's not a valid business type." });
    }
    config.type = body.type.trim();
  }
  if (typeof body.phone === "string" && body.phone.trim()) {
    if (!isPhoneShaped(body.phone.trim())) {
      return res.status(400).json({ error: "That doesn't look like a valid phone number." });
    }
    config.phone = body.phone.trim();
  }
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
  // Omitted entirely = leave the current avatar alone. An explicit "" means
  // "reset to the default face" (theme.avatarUrl removed, so the widget
  // falls back to its own DEFAULT_AVATAR_URL) - anything else must match a
  // real preset or an upload this same endpoint's own api/upload-avatar.js
  // already committed, same trust boundary sanitizeCommittedConfig() uses
  // for a brand new signup.
  if (typeof body.avatarUrl === "string") {
    var avatarUrl = body.avatarUrl.trim();
    config.theme = config.theme || {};
    if (!avatarUrl) {
      delete config.theme.avatarUrl;
    } else if (isKnownAvatarUrl(avatarUrl)) {
      config.theme.avatarUrl = avatarUrl;
    } else {
      return res.status(400).json({ error: "That doesn't look like a valid avatar image." });
    }
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
      var privFile = await getFile(`api/_private-configs/${businessKey}.json`);
      await putFile(`api/_private-configs/${businessKey}.json`, { notifyEmail: notifyEmailToSave },
        `Update contact email for ${businessKey}`, privFile && privFile.sha);
    }
  } catch (err) {
    console.error("[frontdesk dashboard] save error:", err.message);
    if (err.conflict) {
      return res.status(409).json({ error: "This was just updated elsewhere - please refresh and try again." });
    }
    return res.status(502).json({ error: "Could not save your changes - please try again." });
  }

  config.notifyEmail = notifyEmailToSave; // restore for the response - the frontend renders this back optimistically
  return res.status(200).json({ saved: true, config: config });
}

async function handleBillingPortal(req, res, businessKey) {
  if (!stripe) return res.status(500).json({ error: "Billing isn't configured yet" });

  var config = loadConfig(businessKey);
  if (!config || !config.stripeCustomerId) {
    return res.status(404).json({ error: "No billing account found for this business." });
  }

  try {
    var session = await stripe.billingPortal.sessions.create({
      customer: config.stripeCustomerId,
      return_url: SITE_BASE_URL + "/site/dashboard.html"
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[frontdesk dashboard] billing-portal error:", err.message);
    return res.status(502).json({ error: "Could not open billing management - please try again." });
  }
}

// Client-initiated pause/resume - mirrors handleAdminToggle's webhook-
// independent flip (never touches Stripe, same as that function's own
// comment explains) but scoped to the CALLER'S OWN business via the
// session rather than a businessKey in the body, so a logged-in client can
// only ever pause/resume themselves, never another business. Deliberately
// doesn't check subscription status either way - same simple override
// philosophy as the admin toggle, just self-service.
async function handleToggleActive(req, res, businessKey) {
  var body = req.body || {};
  if (body.active !== true && body.active !== false) {
    return res.status(400).json({ error: "active must be true or false" });
  }

  var result = await loadConfigLive(businessKey);
  if (!result) return res.status(404).json({ error: "Business not found" });

  var config = result.config;
  config.active = body.active;
  delete config.notifyEmail; // see handleSave()'s matching guard - never written to the public config

  try {
    await putFile(`configs/${businessKey}.json`, config, `${body.active ? "Resume" : "Pause"} ${businessKey} (client toggle)`, result.sha);
  } catch (err) {
    console.error("[frontdesk dashboard] toggle-active error:", err.message);
    if (err.conflict) {
      return res.status(409).json({ error: "This was just updated elsewhere - please refresh and try again." });
    }
    return res.status(502).json({ error: "Could not save that change - please try again." });
  }

  return res.status(200).json({ saved: true, active: config.active });
}

// Every business, for the founder's own ops view - not the widget-facing
// "one business" shape the rest of this file deals with. loadConfigLive
// (not loadConfig) so a business just toggled below shows up-to-date
// immediately, the same staleness trap already documented on loadConfig()
// itself. Each business's own work is wrapped in its own try/catch so one
// business's GitHub/usage hiccup can't take down the whole list - same
// per-key error isolation api/weekly-digest.js's scan loop already uses.
async function handleAdminList(req, res) {
  var keys = listBusinessKeys();
  var rows = await Promise.all(keys.map(async function (key) {
    try {
      var result = await loadConfigLive(key);
      if (!result) return null;
      var config = result.config;
      var leadData = await readLeads(key);
      var usage = await getUsage(key);
      return {
        businessKey: key,
        businessName: config.businessName,
        domain: config.domain || "",
        type: config.type || "general",
        active: config.active !== false,
        stripeCustomerId: config.stripeCustomerId || "",
        leadCount: leadData.all.length,
        messages: usage.messages,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
      };
    } catch (err) {
      console.error("[frontdesk dashboard] admin-list error for", key, ":", err.message);
      return { businessKey: key, businessName: key, error: "Could not load this business right now" };
    }
  }));
  return res.status(200).json({ businesses: rows.filter(Boolean) });
}

// A manual override switch, not a replacement for real billing cancellation -
// only ever flips the same `active` flag api/stripe-webhook.js already sets
// automatically on a genuine Stripe cancellation. Deliberately does NOT
// touch Stripe at all; the admin page links to each business's own Stripe
// customer page for actual billing actions instead.
async function handleAdminToggle(req, res) {
  var body = req.body || {};
  var businessKey = (body.businessKey || "").toString();
  if (body.active !== true && body.active !== false) {
    return res.status(400).json({ error: "active must be true or false" });
  }

  var result = await loadConfigLive(businessKey);
  if (!result) return res.status(404).json({ error: "Business not found" });

  var config = result.config;
  config.active = body.active;
  // loadConfigLive() merges the private notifyEmail into this same object -
  // configs/{key}.json is served to the public internet as-is, so it must
  // never end up in there, same guard handleSave() already applies at its
  // own write.
  delete config.notifyEmail;

  try {
    await putFile(`configs/${businessKey}.json`, config, `Admin ${body.active ? "reactivate" : "deactivate"} ${businessKey}`, result.sha);
  } catch (err) {
    console.error("[frontdesk dashboard] admin-toggle error:", err.message);
    if (err.conflict) {
      return res.status(409).json({ error: "This was just updated elsewhere - please refresh and try again." });
    }
    return res.status(502).json({ error: "Could not save that change - please try again." });
  }

  return res.status(200).json({ saved: true, active: config.active });
}

module.exports = async function handler(req, res) {
  if (!isTrustedOrigin(req)) return res.status(403).json({ error: "Forbidden" });

  var action = (req.query && req.query.action) || "";

  // Checked and returned BEFORE the business-session gate below, so an
  // admin action can never fall through into business-dashboard logic (or
  // vice versa) - the two are gated on entirely separate cookies/sessions.
  if (action === "admin-list" || action === "admin-toggle") {
    var adminEmail = getSessionAdminEmail(req);
    if (!adminEmail) return res.status(401).json({ error: "Not logged in" });
    if (req.method === "GET" && action === "admin-list") return handleAdminList(req, res);
    if (req.method === "POST" && action === "admin-toggle") return handleAdminToggle(req, res);
    return res.status(405).json({ error: "Method not allowed" });
  }

  var businessKey = getSessionBusinessKey(req);
  if (!businessKey) return res.status(401).json({ error: "Not logged in" });

  if (req.method === "GET") return handleGetData(req, res, businessKey);

  if (req.method === "POST") {
    if (action === "billing-portal") return handleBillingPortal(req, res, businessKey);
    if (action === "toggle-active") return handleToggleActive(req, res, businessKey);
    if (action === "save" || !action) return handleSave(req, res, businessKey);
    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
