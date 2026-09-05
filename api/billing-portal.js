// Vercel serverless function - session-protected, Origin-checked. Hands
// off subscription management (cancel, update card, view invoices)
// entirely to Stripe's own hosted Customer Portal rather than building any
// of that UI here - one API call creates a portal session tied to the
// business's stripeCustomerId, and Stripe handles everything after that.
const Stripe = require("stripe");
const { loadConfig } = require("./_lib/config");
const { getSessionBusinessKey } = require("./_lib/session");
const { isTrustedOrigin } = require("./_lib/cors");

// Lazy, not eager - see api/create-checkout.js for why: an unset
// STRIPE_SECRET_KEY should fail one request cleanly, not crash the module.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://frontdesk-ai-chi-ten.vercel.app";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isTrustedOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  if (!stripe) return res.status(500).json({ error: "Billing isn't configured yet" });

  var businessKey = getSessionBusinessKey(req);
  if (!businessKey) return res.status(401).json({ error: "Not logged in" });

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
    console.error("[frontdesk billing-portal] error:", err.message);
    return res.status(502).json({ error: "Could not open billing management - please try again." });
  }
};
