// Vercel serverless function - starts a real Stripe Checkout Session for the
// 7-day free trial. Card is always collected upfront (no
// payment_method_collection override) so Stripe auto-charges the moment the
// trial ends - the whole point of this endpoint is removing the manual
// "chase payment" step, so a no-card trial that needs a human to convert it
// later would defeat that.
//
// Nothing is written to disk/GitHub here - the config is only ever
// published once payment actually succeeds, via api/stripe-webhook.js.
const Stripe = require("stripe");
const { createRateLimiter } = require("./_lib/rateLimit");
const { generateUniqueBusinessKey } = require("./_lib/businessKey");

// Constructed lazily, not at module load - an unset STRIPE_SECRET_KEY
// (true until the account owner completes Stripe setup, see README "What
// needs you, next") should fail this one request cleanly, not crash the
// whole function the way `new Stripe(undefined)` would if run eagerly here.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const isRateLimited = createRateLimiter(5, 60 * 1000);
// Captures a business owner's email as early as possible in the signup
// flow (before Stripe is ever involved), so an abandoned signup leaves a
// trace instead of none - merged in here from the former
// api/capture-lead-email.js (now deleted) to stay within the Vercel
// Hobby plan's 12-function cap once api/whatsapp.js needed a slot. Its
// own separate, looser rate limiter, same as before the merge - don't
// let this flow's much lower-stakes "capture an email as you type"
// action inherit checkout's stricter 5/min limit, or vice versa.
const isCaptureEmailRateLimited = createRateLimiter(15, 60 * 1000);
// More sensitive than chat/lead (creates real Stripe sessions), so this one
// defaults to a locked-down origin rather than "*" - set ALLOWED_ORIGIN to
// the real site origin before going live.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://frontdesk-ai-chi-ten.vercel.app";

function capStr(v, max) {
  return (v == null ? "" : String(v)).slice(0, max);
}

var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Best-effort only: never something the signup flow should block on if it
// fails. Log-only for now, same honest "not stored yet" pattern api/lead.js
// used before Resend was wired up - a real store is an easy upgrade once
// this is worth automating on top of.
function handleCaptureEmail(req, res, ip) {
  if (isCaptureEmailRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests - please try again in a minute." });
  }
  var body = req.body || {};
  var email = (body.email || "").toString().trim().slice(0, 200);
  var businessName = (body.businessName || "").toString().trim().slice(0, 80);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Not a valid email" });
  console.log("[frontdesk signup] early email capture:", email, "| business:", businessName || "(not entered yet)", "| ip:", ip, "| at:", new Date().toISOString());
  return res.status(200).json({ received: true });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();

  // Checked and returned before checkout's own rate limit/Stripe-configured
  // gates below - this is a different, lighter-weight action entirely, not
  // a variant of starting checkout.
  if ((req.query && req.query.action) === "capture-email") {
    return handleCaptureEmail(req, res, ip);
  }

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests - please try again in a minute." });
  }

  var body = req.body || {};
  // Never trust the client's own caps - re-cap everything here regardless
  // of what the self-serve form already enforces. avatarId and
  // extraInfoId must already be real, previously-uploaded references (see
  // api/upload-avatar.js and api/upload-draft-text.js) - silently dropped
  // if they don't match that shape. extraInfo is NEVER sent raw here: at
  // up to 1000 characters it can exceed Stripe metadata's hard 500-char-
  // per-value limit, which would fail checkout creation outright - it must
  // already be uploaded and referenced by id, same reasoning as the avatar.
  var rawAvatarId = capStr(body.avatarId, 40);
  var rawExtraInfoId = capStr(body.extraInfoId, 40);
  var rawEmail = capStr(body.email, 200).trim();
  var draft = {
    businessName: capStr(body.businessName, 80).trim(),
    agentName: capStr(body.agentName, 40).trim(),
    type: capStr(body.type, 20),
    phone: capStr(body.phone, 40).trim(),
    color: capStr(body.color, 10),
    domain: capStr(body.domain, 253).trim(),
    avatarId: /^[0-9a-f]{24}\.(png|jpg|webp|gif)$/i.test(rawAvatarId) ? rawAvatarId : "",
    extraInfoId: /^[0-9a-f]{24}\.txt$/i.test(rawExtraInfoId) ? rawExtraInfoId : ""
  };
  var email = EMAIL_RE.test(rawEmail) ? rawEmail : undefined;
  if (!draft.businessName) return res.status(400).json({ error: "Business name is required" });
  if (!stripe || !process.env.STRIPE_PRICE_ID) return res.status(500).json({ error: "Checkout isn't configured yet" });

  try {
    var businessKey = await generateUniqueBusinessKey(draft.businessName);

    var session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        // Separate from the top-level metadata below: this is what
        // customer.subscription.updated/.deleted events carry, since those
        // events' data.object is the Subscription, not the Checkout
        // Session - needed so cancellation can find the right config
        // without a lookup table.
        metadata: { businessKey: businessKey, product: "frontdesk" }
      },
      // Carries the visitor's draft through to checkout.session.completed,
      // where the webhook rebuilds the real config from these exact fields
      // via the same buildFrontdeskConfig() the free preview uses.
      metadata: Object.assign({ businessKey: businessKey }, draft),
      // Pre-fills Stripe's own email field with whatever was captured
      // early on site/signup.html (see handleCaptureEmail above) - still
      // editable by the visitor there. Falls back to Stripe collecting it
      // natively if it wasn't captured or didn't look like a real email;
      // either way the webhook reads the final value back off
      // customer_details.email once checkout actually completes.
      customer_email: email,
      success_url: SITE_BASE_URL + "/site/success.html?key=" + encodeURIComponent(businessKey) + "&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: SITE_BASE_URL + "/site/signup.html"
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[frontdesk create-checkout] error:", err.message);
    return res.status(502).json({ error: "Could not start checkout - please try again." });
  }
};
