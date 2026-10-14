// Vercel serverless function - same reasoning as api/upload-avatar.js:
// Stripe Checkout metadata caps each value at 500 characters, but the
// unified "what your AI knows" chunk list can hold far more than that
// across its up-to-12 entries. This commits the chunks to the repo before
// checkout starts (same GitHub-as-storage pattern as configs and avatars)
// and only a short reference travels through Stripe.
const crypto = require("crypto");
const { putBinaryFile } = require("./_lib/github");
const { createRateLimiter } = require("./_lib/rateLimit");
const { sanitizeChunks } = require("./_lib/config");

const isRateLimited = createRateLimiter(8, 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

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
  var chunks = sanitizeChunks(body.chunks);
  if (!chunks || !chunks.length) return res.status(400).json({ error: "No chunks provided" });

  var draftChunksId = crypto.randomBytes(12).toString("hex") + ".json";

  try {
    await putBinaryFile(
      "configs/drafts/" + draftChunksId,
      Buffer.from(JSON.stringify(chunks), "utf8").toString("base64"),
      "Add draft chunks " + draftChunksId
    );
    return res.status(200).json({ draftChunksId: draftChunksId });
  } catch (err) {
    console.error("[frontdesk upload-draft-chunks] error:", err.message);
    return res.status(502).json({ error: "Could not save that - please try again." });
  }
};
