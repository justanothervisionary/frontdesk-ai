// Vercel serverless function - server-side only. Sends a lead notification
// email to the business via Resend. RESEND_API_KEY lives in a server-side
// env var, never reachable from the browser.
const { loadConfig } = require("./_lib/config");
const { createRateLimiter } = require("./_lib/rateLimit");
const { applyWidgetCors, isOriginAllowed } = require("./_lib/cors");
const { appendLead } = require("./_lib/leadLog");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";

// Same best-effort, provider-independent safety net as api/chat.js - see
// that file's comment for why this isn't a guaranteed persistent limit.
const isRateLimited = createRateLimiter(10, 60 * 1000);

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function sendNotification(config, lead) {
  if (!RESEND_API_KEY || !config.notifyEmail) {
    // Not configured yet = pre-launch/demo, not a real client waiting on a
    // real lead - fine to log and tell the visitor it worked. Once a
    // business is live (has notifyEmail set) this branch should never run
    // for them; if it does, that's a setup bug worth catching in logs.
    console.log("[frontdesk lead] not configured (missing API key or notifyEmail) - lead logged only:", lead);
    return { delivered: false, configured: false };
  }

  var transcriptHtml = (lead.transcript || [])
    .map(function (m) { return "<p><strong>" + escapeHtml(m.role) + ":</strong> " + escapeHtml(m.content) + "</p>"; })
    .join("");

  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: config.notifyEmail,
      bcc: process.env.LEAD_BCC_ADDRESS || undefined, // optional - our own visibility/safety net, not required
      subject: "New website lead: " + lead.name,
      html:
        "<p>New lead from your Frontdesk chat widget (" + escapeHtml(config.businessName) + "):</p>" +
        "<p><strong>Name:</strong> " + escapeHtml(lead.name) + "<br/>" +
        "<strong>Contact:</strong> " + escapeHtml(lead.contact) + "</p>" +
        (transcriptHtml ? "<p>Recent conversation:</p>" + transcriptHtml : "")
    })
  });

  if (!res.ok) {
    console.error("[frontdesk lead] Resend API error:", res.status, await res.text().catch(function () { return ""; }));
    return { delivered: false, configured: true };
  }
  return { delivered: true, configured: true };
}

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
