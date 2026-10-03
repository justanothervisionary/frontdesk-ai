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
const { getSessionBusinessKey, getSessionAdminEmail, getSessionImpersonator, setSessionCookie } = require("./_lib/session");
const { isTrustedOrigin } = require("./_lib/cors");
const { getFile, putFile } = require("./_lib/github");
const { getUsage } = require("./_lib/usage");
const { getMissedQuestions } = require("./_lib/missedQuestions");
const { checkInstallation } = require("./_lib/installCheck");
const { createRateLimiter } = require("./_lib/rateLimit");

// Scoped specifically to admin-edit/admin-impersonate, not the rest of this
// file: a business's own actions (save, toggle-active) can only ever touch
// its OWN data, but one compromised admin session looping these two could
// rewrite or impersonate every business on the platform - a tripwire the
// other actions here don't need.
const isAdminActionRateLimited = createRateLimiter(20, 60 * 1000);

// Lazy, not eager - see api/create-checkout.js for why: an unset
// STRIPE_SECRET_KEY should fail one request cleanly, not crash the module.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://frontdesk-ai-chi-ten.vercel.app";

async function handleGetData(req, res, businessKey) {
  var result = await loadConfigLive(businessKey);
  if (!result) return res.status(404).json({ error: "Business not found" });

  // Independent reads, parallelized rather than stacked as sequential
  // awaits - each already has its own internal error handling (readLeads
  // throws on a real GitHub failure, getUsage/getMissedQuestions never
  // throw at all), so a Promise.all here doesn't need its own try/catch.
  var extras = await Promise.all([readLeads(businessKey), getUsage(businessKey), getMissedQuestions(businessKey, 20)]);
  var leadData = extras[0], usage = extras[1], missedQuestions = extras[2];

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
    // Non-null only when this session was minted by an admin "viewing as"
    // this business (see handleAdminImpersonate) - drives the dashboard's
    // own banner from the session token's own truth, not a side-channel
    // guess like "is an admin cookie also present".
    impersonatedBy: getSessionImpersonator(req),
    // Message count only - raw token counts are an internal cost metric,
    // not something a non-technical business owner needs to see.
    messagesThisPeriod: usage.messages,
    missedQuestions: missedQuestions,
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

// Neutralizes classic CSV formula injection: a lead's name/contact is
// visitor-controlled text ("exactly as they wrote it", per the capture_lead
// tool's own description) with no guarantee it doesn't start with =/+/-/@ -
// opened in Excel/Sheets, a leading one of those triggers formula
// evaluation. Prefixing with a single quote is the standard mitigation
// (OWASP's own recommendation) - it reads as plain text everywhere, at the
// cost of a visible leading quote in some viewers for the rare row that
// actually needed it.
function csvCell(value) {
  var str = (value || "").toString();
  if (/^[=+\-@]/.test(str)) str = "'" + str;
  if (/[",\n]/.test(str)) str = '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// Transcript is deliberately left out of the export entirely - it's
// already viewable per-lead in the dashboard (see handleGetData), and
// including it here would only compound the injection surface above with
// RFC4180 multi-line quoting complexity for no real benefit.
async function handleLeadsExport(req, res, businessKey) {
  var leadData = await readLeads(businessKey);
  var rows = ["Name,Contact,Date"].concat(
    leadData.all.slice().reverse().map(function (l) {
      return [csvCell(l.name), csvCell(l.contact), csvCell(l.at)].join(",");
    })
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  // A plain <a href="/api/dashboard?action=leads-export"> works via the
  // existing session cookie with no fetch+blob dance needed - it's a
  // same-origin top-level GET navigation, so the cookie is sent
  // automatically. isTrustedOrigin()'s Referer fallback (see the module
  // handler below) is specifically what makes this work despite a plain
  // navigation having no Origin header - if a future hardening pass ever
  // locks that down further, this download breaks along with it.
  res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
  return res.status(200).send(rows.join("\r\n"));
}

// On-demand "Check my installation" - business-session-gated. installed
// comes back true/false/null (see api/_lib/installCheck.js for what each
// means) - message is just friendlier copy around the same three states.
async function handleCheckInstall(req, res, businessKey) {
  var config = loadConfig(businessKey);
  if (!config) return res.status(404).json({ error: "Business not found" });
  if (!config.domain) {
    return res.status(200).json({ installed: null, message: "We don't have your website address on file yet, so we can't check this automatically." });
  }

  var installed = await checkInstallation(config.domain, businessKey, 4000);
  var message;
  if (installed === true) {
    message = "Found it - your AI receptionist is live on " + config.domain + ".";
  } else if (installed === false) {
    message = "Couldn't find it on " + config.domain + " right now - if you've recently rebuilt your site, you may need to re-add the install snippet.";
  } else {
    message = "Couldn't check your site just now - please try again shortly.";
  }
  return res.status(200).json({ installed: installed, message: message });
}

// Every business, for the founder's own ops view - not the widget-facing
// "one business" shape the rest of this file deals with. loadConfigLive
// (not loadConfig) so a business just toggled below shows up-to-date
// immediately, the same staleness trap already documented on loadConfig()
// itself. Each business's own work is wrapped in its own try/catch so one
// business's GitHub/usage hiccup can't take down the whole list - same
// per-key error isolation api/weekly-digest.js's scan loop already uses.
// Real billing status/revenue from Stripe itself, not just the `active`
// flag (which is Frontdesk's own webhook/manual-override bit and can
// genuinely diverge from billing reality - e.g. active=true but Stripe
// says past_due - worth surfacing both, not collapsing one into the
// other). Deliberately its OWN try/catch, nested inside the per-business
// one below rather than sharing it: a Stripe hiccup for one business must
// degrade only ITS subscription fields, never wipe out that business's
// otherwise-fine lead/usage numbers by falling into the outer catch.
async function lookupSubscription(config) {
  if (!stripe || !config.stripeSubscriptionId) {
    return { subscriptionStatus: "none", mrr: 0 };
  }
  try {
    var sub = await stripe.subscriptions.retrieve(config.stripeSubscriptionId);
    var mrr = 0;
    if (sub.status === "active" && sub.items && sub.items.data[0] && sub.items.data[0].price) {
      mrr = (sub.items.data[0].price.unit_amount || 0) / 100; // unit_amount is pence, not pounds
    }
    return { subscriptionStatus: sub.status, mrr: mrr };
  } catch (err) {
    console.error("[frontdesk dashboard] stripe lookup failed:", config.businessName, err.message);
    return { subscriptionStatus: "unknown", mrr: 0 };
  }
}

async function handleAdminList(req, res) {
  var keys = listBusinessKeys();
  var rows = await Promise.all(keys.map(async function (key) {
    try {
      var result = await loadConfigLive(key);
      if (!result) return null;
      var config = result.config;
      var leadData = await readLeads(key);
      var usage = await getUsage(key);
      var subscription = await lookupSubscription(config);
      return {
        businessKey: key,
        businessName: config.businessName,
        domain: config.domain || "",
        type: config.type || "general",
        // phone/notifyEmail weren't needed here before admin-edit existed -
        // now the admin UI needs something to pre-fill its edit form with,
        // same reasoning handleGetData already applies for the client's own
        // dashboard. loadConfigLive() already merges notifyEmail in from the
        // private file (see its own comment), so no extra read needed here.
        phone: config.phone || "",
        notifyEmail: config.notifyEmail || "",
        active: config.active !== false,
        stripeCustomerId: config.stripeCustomerId || "",
        subscriptionStatus: subscription.subscriptionStatus,
        mrr: subscription.mrr,
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
  var businesses = rows.filter(Boolean);
  var totalMrr = businesses.reduce(function (sum, b) { return sum + (b.mrr || 0); }, 0);
  return res.status(200).json({ businesses: businesses, totalMrr: totalMrr });
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

// Fixes exactly the kind of mismatch that needed a hand-edited JSON file
// this session (Spearson's Group showing as "Barang business") - admin
// acting on ANOTHER business's identity fields, not a second copy of the
// full client dashboard. Deliberately filters the body down to just these
// 4 fields before delegating to handleSave's own field-sanitization logic -
// handleSave takes businessKey as a plain parameter already, so reuse is
// clean, but passing the RAW admin request body through would silently
// also accept every other field handleSave whitelists (faqs, greeting,
// assistantName, avatarUrl) - not a security hole since admin is already
// trusted, but scope drift: the backend would permit more than this admin
// action's own UI implies, with zero review.
async function handleAdminEdit(req, res) {
  var body = req.body || {};
  var targetBusinessKey = (body.businessKey || "").toString();
  if (!targetBusinessKey) return res.status(400).json({ error: "businessKey is required" });

  var filtered = {};
  ["businessName", "type", "phone", "notifyEmail"].forEach(function (field) {
    if (typeof body[field] === "string") filtered[field] = body[field];
  });
  return handleSave({ body: filtered }, res, targetBusinessKey);
}

// "View as this business" for support - mints a real business session via
// the already-exported setSessionCookie rather than a magic-link email,
// since the admin is already authenticated and this is an explicit,
// intentional support action. impersonatedBy is baked into the signed
// session payload itself (see api/_lib/session.js) so the dashboard's own
// banner is driven by the token's truth, never a side-channel guess.
// Exiting is just the existing /api/auth?action=logout - confirmed it only
// clears the business cookie, leaving the admin's own session untouched.
async function handleAdminImpersonate(req, res, adminEmail, ip) {
  var body = req.body || {};
  var targetBusinessKey = (body.businessKey || "").toString();
  if (!targetBusinessKey) return res.status(400).json({ error: "businessKey is required" });

  // Cheap local check (no network) purely so a fat-fingered businessKey
  // produces a clear error now rather than a cookie for nothing - a
  // downstream handleGetData would 404 gracefully either way, so this is
  // audit-quality, not a security boundary.
  var config = loadConfig(targetBusinessKey);
  if (!config) return res.status(404).json({ error: "Business not found" });

  console.log("[frontdesk dashboard] admin impersonation:", JSON.stringify({
    adminEmail: adminEmail, targetBusinessKey: targetBusinessKey, ip: ip, at: new Date().toISOString()
  }));

  setSessionCookie(res, targetBusinessKey, adminEmail);
  return res.status(200).json({ impersonating: targetBusinessKey });
}

module.exports = async function handler(req, res) {
  if (!isTrustedOrigin(req)) return res.status(403).json({ error: "Forbidden" });

  var action = (req.query && req.query.action) || "";
  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();

  // Checked and returned BEFORE the business-session gate below, so an
  // admin action can never fall through into business-dashboard logic (or
  // vice versa) - the two are gated on entirely separate cookies/sessions.
  if (action === "admin-list" || action === "admin-toggle" || action === "admin-edit" || action === "admin-impersonate") {
    var adminEmail = getSessionAdminEmail(req);
    if (!adminEmail) return res.status(401).json({ error: "Not logged in" });
    if (req.method === "GET" && action === "admin-list") return handleAdminList(req, res);
    if (req.method === "POST" && action === "admin-toggle") return handleAdminToggle(req, res);
    if (req.method === "POST" && (action === "admin-edit" || action === "admin-impersonate")) {
      if (isAdminActionRateLimited(ip)) return res.status(429).json({ error: "Too many requests - please try again in a minute." });
      if (action === "admin-edit") return handleAdminEdit(req, res);
      return handleAdminImpersonate(req, res, adminEmail, ip);
    }
    return res.status(405).json({ error: "Method not allowed" });
  }

  var businessKey = getSessionBusinessKey(req);
  if (!businessKey) return res.status(401).json({ error: "Not logged in" });

  if (req.method === "GET") {
    if (action === "leads-export") return handleLeadsExport(req, res, businessKey);
    return handleGetData(req, res, businessKey);
  }

  if (req.method === "POST") {
    if (action === "billing-portal") return handleBillingPortal(req, res, businessKey);
    if (action === "toggle-active") return handleToggleActive(req, res, businessKey);
    if (action === "check-install") return handleCheckInstall(req, res, businessKey);
    if (action === "save" || !action) return handleSave(req, res, businessKey);
    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
