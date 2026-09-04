// Vercel Cron target (see vercel.json's "crons") - runs once a week and
// emails every active, real business a short summary of the leads their
// AI receptionist captured, so the value of the £45/mo stays visible
// instead of going quiet after the initial sale. Closing that loop was
// flagged as a real churn risk before this existed - a client who can't
// see it's still working has no reason not to cancel.
//
// Deliberately scoped to LEAD COUNTS only, not raw chat-message volume.
// Leads are rare enough that logging one commit per lead (api/_lib/leadLog.js)
// is a reasonable reuse of the git-based storage this project already uses
// everywhere else. Every chat message is not - that volume needs a real
// fast counter store (Vercel KV / Upstash, the same upgrade path already
// noted in SECURITY.md for rate limiting), which is a genuinely new piece
// of infrastructure, not a "use what's already there" change. Worth adding
// later if chat-volume reporting turns out to matter; leads are the higher-
// signal number anyway (a client cares more about "3 real enquiries" than
// "40 messages answered").
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./_lib/config");
const { readLeads, writePrunedLeads } = require("./_lib/leadLog");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";
const CONFIGS_DIR = path.join(__dirname, "..", "configs");

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// configs/ also holds avatars/ and drafts/ subdirectories, not just
// business config files - only the top-level *.json files are real
// businesses.
function listBusinessKeys() {
  return fs.readdirSync(CONFIGS_DIR)
    .filter(function (f) { return f.endsWith(".json"); })
    .map(function (f) { return f.slice(0, -".json".length); });
}

async function sendDigest(config, thisWeek) {
  var body = thisWeek.length
    ? "<p>Your AI receptionist captured " + thisWeek.length + " new " + (thisWeek.length === 1 ? "lead" : "leads") + " this week:</p><ul>" +
      thisWeek.map(function (l) { return "<li><strong>" + escapeHtml(l.name) + "</strong> - " + escapeHtml(l.contact) + "</li>"; }).join("") +
      "</ul>"
    : "<p>Your AI receptionist didn't capture any new leads this week. It's still live and answering questions on your site - worth checking it's still installed correctly if that seems off.</p>";

  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: config.notifyEmail,
      bcc: process.env.LEAD_BCC_ADDRESS || undefined,
      subject: "Your weekly Frontdesk summary - " + config.businessName,
      html: body
    })
  });

  if (!res.ok) {
    throw new Error("Resend API error " + res.status + ": " + await res.text().catch(function () { return ""; }));
  }
}

module.exports = async function handler(req, res) {
  // Vercel automatically sends this bearer token on cron-triggered
  // invocations when CRON_SECRET is set as a project env var. Checking it
  // stops anyone else from mass-emailing every client just by hitting this
  // URL directly - unlike the widget-facing endpoints, this one was never
  // meant to be called from a browser at all.
  var auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== "Bearer " + process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: "Resend isn't configured" });
  }

  var results = { sent: 0, skipped: 0, failed: 0 };

  for (var key of listBusinessKeys()) {
    try {
      var config = loadConfig(key);
      // Skip anything cancelled, or with no real contact email yet (demo/
      // outreach configs, or a business mid-setup) - nobody real to email.
      if (!config || config.active === false || !config.notifyEmail) {
        results.skipped++;
        continue;
      }

      var leadData = await readLeads(key);
      await sendDigest(config, leadData.thisWeek);

      // Only write back if pruning actually removed something old - a
      // business with no stale leads shouldn't generate a pointless commit
      // every single week.
      if (leadData.prunedCount > 0) {
        await writePrunedLeads(key, leadData.all, leadData.sha);
      }

      results.sent++;
    } catch (err) {
      console.error("[frontdesk weekly-digest] failed for", key, ":", err.message);
      results.failed++;
    }
  }

  console.log("[frontdesk weekly-digest] run complete:", results);
  return res.status(200).json(results);
};
