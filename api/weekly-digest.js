// Vercel Cron target (see vercel.json's "crons") - runs once a week and
// emails every active, real business a short summary of the leads their
// AI receptionist captured, so the value of the £45/mo stays visible
// instead of going quiet after the initial sale. Closing that loop was
// flagged as a real churn risk before this existed - a client who can't
// see it's still working has no reason not to cancel.
//
// Deliberately scoped to LEAD COUNTS only, not raw chat-message volume -
// leads are the higher-signal number for a client anyway (they care more
// about "3 real enquiries" than "40 messages answered"). Chat-message/token
// volume is now tracked separately (api/_lib/usage.js, backed by Upstash -
// see its own comments for why the git-commit pattern below isn't a fit for
// that frequency) and surfaces on the admin dashboard instead, not here.
const { loadConfig, listBusinessKeys } = require("./_lib/config");
const { readLeads, writePrunedLeads } = require("./_lib/leadLog");
const { buildDigestEmail } = require("./_lib/digestEmail");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";

async function sendDigest(config, thisWeek) {
  var email = buildDigestEmail(config, thisWeek);

  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: config.notifyEmail,
      bcc: process.env.LEAD_BCC_ADDRESS || undefined,
      subject: email.subject,
      html: email.html
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
      // Skip anything cancelled, with no real contact email yet, or that
      // never actually went through a real Stripe signup (stripeCustomerId
      // only gets set by api/stripe-webhook.js on a genuine paid checkout -
      // a hand-built outreach/demo config like dentistw4 has a real
      // notifyEmail once we've found it, but was never actually offered
      // this product, so it has no business getting an unsolicited "your
      // weekly summary" email).
      if (!config || config.active === false || !config.notifyEmail || !config.stripeCustomerId) {
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
