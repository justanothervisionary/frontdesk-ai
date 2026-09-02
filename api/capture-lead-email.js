// Vercel serverless function - captures a business owner's email as early
// as possible in the signup flow (on the new site/signup.html, before
// Stripe is ever involved), so an abandoned signup leaves a trace instead
// of none. Best-effort only: never something the signup flow should block
// on if it fails. Log-only for now, same honest "not stored yet" pattern
// api/lead.js used before Resend was wired up - a real store is an easy
// upgrade once this is worth automating on top of.
const { createRateLimiter } = require("./_lib/rateLimit");

const isRateLimited = createRateLimiter(15, 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

  var body = req.body || {};
  var email = (body.email || "").toString().trim().slice(0, 200);
  var businessName = (body.businessName || "").toString().trim().slice(0, 80);

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Not a valid email" });

  console.log("[frontdesk signup] early email capture:", email, "| business:", businessName || "(not entered yet)", "| ip:", ip, "| at:", new Date().toISOString());

  return res.status(200).json({ received: true });
};
