// Builds the weekly digest email (api/weekly-digest.js) - deliberately its
// own module, not inlined, so the HTML can be eyeballed/iterated on without
// touching the cron orchestration logic.
//
// Styled to match the marketing site's own look (site/index.html's design
// tokens: near-black background, the glowing green "alive" dot, the same
// system font stack) rather than each business's own accent color - the
// point of this email is to feel like "your Frontdesk AI solution checking
// in", a consistent brand touchpoint, not a themed extension of their site.
//
// Email clients are a much harsher rendering environment than a browser -
// no CSS gradients/background-clip:text (used on the site's own heading),
// no guaranteed <style> block support in Outlook - so this uses a
// table-based layout with every style inlined, which is the one approach
// that reliably survives Gmail, Outlook, and Apple Mail alike.
var FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
var COLORS = {
  pageBg: "#f4f5f7",
  cardBg: "#0a0b0d",
  rowBg: "#14161a",
  border: "#22262d",
  text: "#f3f4f6",
  bodyText: "#c3c8d1",
  muted: "#9aa1ac",
  faint: "#6b7280",
  accent: "#35d68f",
  onAccent: "#04160c"
};

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function weekdayOf(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { weekday: "long" });
  } catch (e) {
    return "";
  }
}

function leadRow(lead, isLast) {
  var initial = escapeHtml((lead.name || "?").trim().charAt(0).toUpperCase() || "?");
  var day = weekdayOf(lead.at);
  return (
    '<tr><td style="padding:0 0 ' + (isLast ? "0" : "10") + 'px 0;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + COLORS.rowBg + ';border:1px solid ' + COLORS.border + ';border-radius:12px;">' +
        '<tr>' +
          '<td width="60" style="padding:14px 0 14px 16px;">' +
            '<div style="width:36px;height:36px;border-radius:50%;background:' + COLORS.accent + ';color:' + COLORS.onAccent + ';font-family:' + FONT + ';font-weight:800;font-size:15px;line-height:36px;text-align:center;">' + initial + '</div>' +
          '</td>' +
          '<td style="padding:14px 16px 14px 4px;font-family:' + FONT + ';">' +
            '<div style="color:' + COLORS.text + ';font-weight:700;font-size:14px;">' + escapeHtml(lead.name) + '</div>' +
            '<div style="color:' + COLORS.muted + ';font-size:13px;margin-top:2px;">' + escapeHtml(lead.contact) + (day ? " &middot; left a message " + day : "") + '</div>' +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</td></tr>'
  );
}

// Returns { subject, html }. `thisWeek` is an array of { name, contact, at }
// (see api/_lib/leadLog.js). `config` is the loaded, sanitized business
// config - assistantName comes from config.theme.assistantName.
function buildDigestEmail(config, thisWeek) {
  var assistantName = (config.theme && config.theme.assistantName) || "Your AI receptionist";
  var count = thisWeek.length;
  var hasLeads = count > 0;

  var subject = hasLeads
    ? "🎉 " + count + " new " + (count === 1 ? "lead" : "leads") + " this week - " + config.businessName
    : config.businessName + "'s weekly Frontdesk check-in";

  var headline = hasLeads
    ? (count === 1 ? "🎉 1 new lead this week" : "🎉 " + count + " new leads this week")
    : "👋 A quiet week on the leads front";

  var subline = hasLeads
    ? escapeHtml(assistantName) + " helped these visitors on your site and passed them straight to you - real people, real opportunities."
    : escapeHtml(assistantName) + " was on duty all week answering questions - no one left their details this time, but it's live, working, and ready for the next visitor.";

  var leadsBlock = hasLeads
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        thisWeek.map(function (l, i) { return leadRow(l, i === thisWeek.length - 1); }).join("") +
      '</table>'
    : "";

  var html =
    '<div style="background:' + COLORS.pageBg + ';padding:32px 16px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">' +
        '<tr><td style="background:' + COLORS.cardBg + ';border-radius:16px;overflow:hidden;">' +

          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
            '<tr><td style="padding:28px 32px 0 32px;">' +
              '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
                '<td style="padding-right:8px;"><div style="width:10px;height:10px;border-radius:50%;background:' + COLORS.accent + ';"></div></td>' +
                '<td style="font-family:' + FONT + ';color:' + COLORS.text + ';font-weight:800;font-size:16px;letter-spacing:-0.02em;">Frontdesk</td>' +
              '</tr></table>' +
            '</td></tr>' +

            '<tr><td style="padding:22px 32px 4px 32px;font-family:' + FONT + ';">' +
              '<div style="color:' + COLORS.muted + ';font-size:13px;margin-bottom:8px;">Weekly summary for ' + escapeHtml(config.businessName) + '</div>' +
              '<div style="color:' + COLORS.text + ';font-size:23px;font-weight:800;letter-spacing:-0.02em;line-height:1.3;">' + headline + '</div>' +
              '<div style="color:' + COLORS.bodyText + ';font-size:14px;margin-top:10px;line-height:1.55;">' + subline + '</div>' +
            '</td></tr>' +

            (hasLeads ? '<tr><td style="padding:20px 32px 0 32px;">' + leadsBlock + '</td></tr>' : '') +

            '<tr><td style="padding:28px 32px 24px 32px;">' +
              '<table role="presentation" cellpadding="0" cellspacing="0" style="border-radius:9px;background:' + COLORS.accent + ';">' +
                '<tr><td style="padding:11px 20px;font-family:' + FONT + ';font-size:13px;font-weight:700;color:' + COLORS.onAccent + ';">' +
                  '<a href="https://frontdesk-ai-chi-ten.vercel.app" style="color:' + COLORS.onAccent + ';text-decoration:none;">See Frontdesk in action &rarr;</a>' +
                '</td></tr>' +
              '</table>' +
            '</td></tr>' +

            '<tr><td style="padding:18px 32px 24px 32px;border-top:1px solid ' + COLORS.border + ';">' +
              '<div style="font-family:' + FONT + ';color:' + COLORS.faint + ';font-size:12px;line-height:1.6;">This is your automated weekly summary, sent every Monday by ' + escapeHtml(assistantName) + ' on Frontdesk. Nothing to do here - it just keeps working.</div>' +
            '</td></tr>' +

          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</div>';

  return { subject: subject, html: html };
}

module.exports = { buildDigestEmail };
