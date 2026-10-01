// Vercel serverless function - server-side only. Sends a lead notification
// email to the business via Resend. RESEND_API_KEY lives in a server-side
// env var, never reachable from the browser.
//
// This is the visitor-initiated path (the "leave your details" form). As
// of the AI being able to capture a lead directly from the conversation
// too (api/chat.js), sendNotification() itself lives in api/_lib/leadNotify.js
// so both paths trigger the exact same notification, never two copies that
// could drift apart.
const { loadConfig } = require("./_lib/config");
const { createRateLimiter } = require("./_lib/rateLimit");
const { applyWidgetCors, isOriginAllowed } = require("./_lib/cors");
const { appendLead } = require("./_lib/leadLog");
const { sendNotification } = require("./_lib/leadNotify");

// Same best-effort, provider-independent safety net as api/chat.js - see
// that file's comment for why this isn't a guaranteed persistent limit.
const isRateLimited = createRateLimiter(10, 60 * 1000);

module.exports = async function handler(req, res) {
  applyWidgetCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests - please try again in a minute." });
  }

  var body = req.body || {};
  var businessKey = body.businessKey;
  var name = (body.name || "").toString().trim().slice(0, 200);
  var contact = (body.contact || "").toString().trim().slice(0, 200);
  var transcript = Array.isArray(body.transcript) ? body.transcript.slice(-6) : [];

  var config = loadConfig(businessKey);
  if (!config) return res.status(400).json({ error: "Unknown business" });
  if (!isOriginAllowed(req.headers.origin, config)) {
    return res.status(403).json({ error: "This origin is not authorized for this business." });
  }
  if (config.active === false) {
    return res.status(403).json({ error: "This assistant is no longer active." });
  }
  if (!name || !contact) return res.status(400).json({ error: "Name and contact are required" });

  // Run in parallel, not sequentially - the digest log write is pure
  // bookkeeping for api/weekly-digest.js and must never slow down or break
  // the actual notification the visitor is relying on, so its result (and
  // any failure) is deliberately ignored here.
  var results = await Promise.all([
    sendNotification(config, { name: name, contact: contact, transcript: transcript }),
    appendLead(businessKey, { name: name, contact: contact }).catch(function (err) {
      console.error("[frontdesk lead] failed to log lead for digest:", businessKey, err.message);
    })
  ]);
  var result = results[0];

  // Only surface a failure to the visitor when this business is actually
  // configured for live leads and delivery genuinely failed - in that case
  // they should know to call instead rather than walk away thinking
  // they're covered. If it's just not configured yet (pre-launch/demo),
  // that's on us to catch in logs, not something to alarm a demo visitor
  // with.
  if (result.configured && !result.delivered) {
    return res.status(502).json({ error: "Failed to deliver - please call instead." });
  }
  return res.status(200).json({ received: true, delivered: result.delivered });
};
