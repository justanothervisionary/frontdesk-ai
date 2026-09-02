// Vercel serverless function - same reasoning as api/upload-avatar.js:
// Stripe Checkout metadata caps each value at 500 characters, but the
// "teach it something about your business" box now allows up to 1000 -
// sending it straight through Stripe metadata silently breaks checkout
// creation above that limit. This commits the text to the repo before
// checkout starts (same GitHub-as-storage pattern as configs and avatars)
// and only a short reference travels through Stripe.
const crypto = require("crypto");
const { putBinaryFile } = require("./_lib/github");
const { createRateLimiter } = require("./_lib/rateLimit");

const isRateLimited = createRateLimiter(8, 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_CHARS = 2000; // headroom above the 1000-char UI cap for future sources (e.g. PDF extraction)

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
  var text = (body.text || "").toString().trim().slice(0, MAX_CHARS);
  if (!text) return res.status(400).json({ error: "No text provided" });

  var draftTextId = crypto.randomBytes(12).toString("hex") + ".txt";

  try {
    await putBinaryFile(
      "configs/drafts/" + draftTextId,
      Buffer.from(text, "utf8").toString("base64"),
      "Add draft training text " + draftTextId
    );
    return res.status(200).json({ draftTextId: draftTextId });
  } catch (err) {
    console.error("[frontdesk upload-draft-text] error:", err.message);
    return res.status(502).json({ error: "Could not save that text - please try again." });
  }
};
