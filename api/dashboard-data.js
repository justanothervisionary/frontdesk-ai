// Vercel serverless function - session-protected. Returns the logged-in
// business's own current config plus their recent leads, for
// site/dashboard.html to render. Uses loadConfigLive() (not the faster
// loadConfig() api/chat.js/api/lead.js use) specifically so a business
// sees their own just-saved edit immediately rather than the old value
// for the ~1-2 minutes a fresh Vercel deploy takes - see api/_lib/config.js.
const { loadConfigLive } = require("./_lib/config");
const { readLeads } = require("./_lib/leadLog");
const { getSessionBusinessKey } = require("./_lib/session");
const { isTrustedOrigin } = require("./_lib/cors");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isTrustedOrigin(req)) return res.status(403).json({ error: "Forbidden" });

  var businessKey = getSessionBusinessKey(req);
  if (!businessKey) return res.status(401).json({ error: "Not logged in" });

  var result = await loadConfigLive(businessKey);
  if (!result) return res.status(404).json({ error: "Business not found" });

  var leadData = await readLeads(businessKey);

  return res.status(200).json({
    businessKey: businessKey,
    businessName: result.config.businessName,
    greeting: result.config.greeting,
    fallbackAnswer: result.config.fallbackAnswer,
    faqs: result.config.faqs || [],
    notifyEmail: result.config.notifyEmail || "",
    assistantName: (result.config.theme && result.config.theme.assistantName) || "Ivy",
    active: result.config.active !== false,
    // All leads within the 35-day retention window, not just this week's
    // slice (that narrower view is specifically for the weekly digest
    // email) - a business checking their own dashboard wants everything
    // recent, newest first.
    leads: leadData.all.slice().reverse()
  });
};
