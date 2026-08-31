// Vercel serverless function - accepts a photo/logo from the self-serve
// tool and commits it to the repo (same GitHub-as-storage pattern already
// used for configs) BEFORE checkout starts. This exists purely because of a
// Stripe limitation: Checkout Session metadata caps each value at 500
// characters, far too small for a real image's data URI, so the image has
// to already be hosted somewhere with a short, stable URL by the time
// checkout metadata is built - this endpoint is that "somewhere."
const crypto = require("crypto");
const { putBinaryFile } = require("./_lib/github");
const { createRateLimiter } = require("./_lib/rateLimit");

const isRateLimited = createRateLimiter(8, 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// data:image/png;base64,AAAA... - captures the MIME type and the raw base64
// payload separately so each can be validated on its own terms.
const DATA_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const MAX_BYTES = 2 * 1024 * 1024; // 2MB - matches the client-side cap

const EXT_FOR_MIME = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp", gif: "gif" };

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many uploads - please try again in a minute." });
  }

  var body = req.body || {};
  var dataUri = (body.imageDataUri || "").toString();
  // Hard cap on the raw string length too, before even attempting the
  // regex/decode - cheap defense against a deliberately huge payload wasting
  // CPU on validation alone. Base64 inflates size by ~4/3, so a little
  // headroom above MAX_BYTES is expected and fine.
  if (dataUri.length > MAX_BYTES * 2) {
    return res.status(413).json({ error: "Image is too large." });
  }

  var match = DATA_URI_RE.exec(dataUri);
  if (!match) {
    return res.status(400).json({ error: "Expected a PNG, JPEG, WebP, or GIF image." });
  }

  var ext = EXT_FOR_MIME[match[1].toLowerCase()];
  var base64Content = match[2];
  var byteLength = Math.floor(base64Content.length * 3 / 4);
  if (byteLength > MAX_BYTES) {
    return res.status(413).json({ error: "Image is too large - please use something under 2MB." });
  }

  var avatarId = crypto.randomBytes(12).toString("hex") + "." + ext;

  try {
    await putBinaryFile(
      "configs/avatars/" + avatarId,
      base64Content,
      "Add uploaded avatar " + avatarId
    );
    return res.status(200).json({ avatarId: avatarId });
  } catch (err) {
    console.error("[frontdesk upload-avatar] error:", err.message);
    return res.status(502).json({ error: "Could not upload image - please try again." });
  }
};
