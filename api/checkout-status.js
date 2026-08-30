// Vercel serverless function - lets site/success.html tell the difference
// between "still processing," "paid, config publishing," and "session not
// found/expired" instead of blindly polling a static file forever. Also
// hands back the draft businessName/agentName from Stripe's own metadata so
// the wait screen can say something specific ("Personalizing Ziggy...")
// even before the config file itself has gone live.
const Stripe = require("stripe");
const { createRateLimiter } = require("./_lib/rateLimit");

// See api/create-checkout.js for why this is lazy rather than constructed
// eagerly at module load.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const isRateLimited = createRateLimiter(30, 60 * 1000); // polled repeatedly by one visitor while waiting
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests - please slow down." });
  }

  var sessionId = ((req.query && req.query.session_id) || "").toString().slice(0, 200);
  if (!sessionId) return res.status(400).json({ error: "Missing session_id" });
  if (!stripe) return res.status(500).json({ error: "Checkout isn't configured yet" });

  try {
    var session = await stripe.checkout.sessions.retrieve(sessionId);
    var meta = session.metadata || {};
    return res.status(200).json({
      paymentStatus: session.status, // "open" | "complete" | "expired"
      businessKey: meta.businessKey || null,
      businessName: meta.businessName || null,
      agentName: meta.agentName || null
    });
  } catch (err) {
    return res.status(404).json({ error: "Session not found" });
  }
};
