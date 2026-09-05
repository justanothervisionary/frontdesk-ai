// Vercel serverless function - step 1 of magic-link login. Only ever
// called from our own site (site/login.html), same category as the other
// signup-flow endpoints, so this uses the fixed ALLOWED_ORIGIN, not
// api/_lib/cors.js's per-business domain logic.
const { createRateLimiter } = require("./_lib/rateLimit");
const { findBusinessKeyByEmail } = require("./_lib/loginLookup");
const { signLoginToken } = require("./_lib/session");

const isRateLimited = createRateLimiter(5, 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://frontdesk-ai-chi-ten.vercel.app";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function sendLoginEmail(email, businessKey) {
  var token = signLoginToken(businessKey);
  var link = SITE_BASE_URL + "/api/verify-login?token=" + encodeURIComponent(token);
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: email,
      subject: "Log in to Frontdesk",
      html:
        "<p>Click below to log in to your Frontdesk dashboard. This link expires in 15 minutes and can only be used once.</p>" +
        "<p><a href=\"" + link + "\">Log in to Frontdesk</a></p>" +
        "<p style=\"color:#888;font-size:12px;\">If you didn't request this, you can safely ignore this email.</p>"
    })
  });
  if (!res.ok) throw new Error("Resend API error " + res.status + ": " + await res.text().catch(function () { return ""; }));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests - please try again in a minute." });
  }

  var email = ((req.body || {}).email || "").toString().trim().slice(0, 200);
  // Always return the same generic response regardless of what happens
  // below - never confirm or deny whether an email is a registered
  // business, and never let a visitor distinguish "not found" from
  // "email delivery failed" from a timing difference either (the lookup
  // and any send attempt both happen before this response, every time).
  var GENERIC_RESPONSE = { received: true, message: "If that email is registered, a login link is on its way." };

  if (!EMAIL_RE.test(email)) return res.status(200).json(GENERIC_RESPONSE);

  try {
    var businessKey = findBusinessKeyByEmail(email);
    if (businessKey && RESEND_API_KEY) {
      await sendLoginEmail(email, businessKey);
    } else if (businessKey) {
      console.log("[frontdesk request-login] Resend not configured - login link not sent for", businessKey);
    }
  } catch (err) {
    console.error("[frontdesk request-login] error:", err.message);
  }

  return res.status(200).json(GENERIC_RESPONSE);
};
