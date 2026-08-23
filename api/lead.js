// Vercel serverless function - server-side only. Sends a lead notification
// email to the business via Resend. RESEND_API_KEY lives in a server-side
// env var, never reachable from the browser.
const fs = require("fs");
const path = require("path");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";

// Same best-effort, provider-independent safety net as api/chat.js - see
// that file's comment for why this isn't a guaranteed persistent limit.
const requestLog = new Map();
const MAX_REQUESTS_PER_WINDOW = 10;
const WINDOW_MS = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestLog.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  requestLog.set(ip, entry);
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

function loadConfig(businessKey) {
  if (!/^[a-z0-9-]+$/.test(businessKey || "")) return null;
  const configPath = path.join(__dirname, "..", "configs", `${businessKey}.json`);
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

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
  res.setHeader("Access-Control-Allow-Origin", "*"); // demo stage - restrict to registered client domains before onboarding real paying clients
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
  if (!name || !contact) return res.status(400).json({ error: "Name and contact are required" });

  var result = await sendNotification(config, { name: name, contact: contact, transcript: transcript });

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
