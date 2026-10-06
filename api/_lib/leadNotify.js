// Sends the lead-notification email to a business via Resend. Extracted
// from api/lead.js (the manual "leave your details" form) so api/chat.js
// can trigger the exact same notification when the AI captures a lead
// directly from the conversation - both paths must behave identically, not
// drift into two copies of the same Resend call.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";
const FETCH_TIMEOUT_MS = 4500;

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// A hard timeout on the Resend call matters more here than it used to -
// this now also runs inside api/chat.js, stacked on top of the Claude call,
// inside the widget's own 8-second abort budget (see
// widget/frontdesk-widget.js's askBackend()). An unbounded hang here could
// otherwise silently eat the time budget for a reply that was already
// generated and ready to send.
//
// lead.source (optional) varies the copy per channel - "whatsapp" or
// unset/anything else (web). Without this, a WhatsApp-sourced lead would
// get an email that says "New website lead" / "from your Frontdesk chat
// widget," which is simply wrong and confusing for a lead that never
// touched the website at all.
async function sendNotification(config, lead) {
  if (!RESEND_API_KEY || !config.notifyEmail) {
    // Not configured yet = pre-launch/demo, not a real client waiting on a
    // real lead - fine to log and tell the visitor it worked. Once a
    // business is live (has notifyEmail set) this branch should never run
    // for them; if it does, that's a setup bug worth catching in logs.
    console.log("[frontdesk lead] not configured (missing API key or notifyEmail) - lead logged only:", lead);
    return { delivered: false, configured: false };
  }

  // lead.source combines channel + event type (e.g. "whatsapp-booking") -
  // covers every real combination explicitly rather than nested ternaries,
  // so a WhatsApp booking confirmation doesn't silently fall back to
  // generic "website lead" wording the way a flat isWhatsApp boolean would
  // once a second event type (booking) exists alongside the original one
  // (a plain captured lead).
  var COPY_BY_SOURCE = {
    "whatsapp": { channelLabel: "WhatsApp AI receptionist", subjectPrefix: "New WhatsApp lead: " },
    "whatsapp-booking": { channelLabel: "WhatsApp AI receptionist", subjectPrefix: "New appointment booked (WhatsApp): " },
    "whatsapp-booking-attempt": { channelLabel: "WhatsApp AI receptionist", subjectPrefix: "Booking attempt, slot taken (WhatsApp): " },
    "booking": { channelLabel: "chat widget", subjectPrefix: "New appointment booked: " },
    "booking-attempt": { channelLabel: "chat widget", subjectPrefix: "Booking attempt, slot taken: " }
  };
  var copy = COPY_BY_SOURCE[lead.source] || { channelLabel: "chat widget", subjectPrefix: "New website lead: " };

  var bookingTimeHtml = lead.bookingTime
    ? "<p><strong>Appointment time:</strong> " + escapeHtml(lead.bookingTime) + "</p>"
    : "";

  var transcriptHtml = (lead.transcript || [])
    .map(function (m) { return "<p><strong>" + escapeHtml(m.role) + ":</strong> " + escapeHtml(m.content) + "</p>"; })
    .join("");

  // lead.attachments is already validated (api/_lib/attachments.js) before
  // it ever reaches here - url is confirmed to be our own Blob storage
  // domain, never visitor-controlled, so it's safe to use directly in an
  // href rather than just as escaped text.
  var attachmentsHtml = (lead.attachments || []).length
    ? "<p><strong>Attachments:</strong><br/>" +
      lead.attachments.map(function (a) { return '<a href="' + a.url + '">' + escapeHtml(a.name) + "</a>"; }).join("<br/>") +
      "</p>"
    : "";

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: config.notifyEmail,
        bcc: process.env.LEAD_BCC_ADDRESS || undefined, // optional - our own visibility/safety net, not required
        subject: copy.subjectPrefix + lead.name,
        html:
          "<p>New activity from your Frontdesk " + copy.channelLabel + " (" + escapeHtml(config.businessName) + "):</p>" +
          "<p><strong>Name:</strong> " + escapeHtml(lead.name) + "<br/>" +
          "<strong>Contact:</strong> " + escapeHtml(lead.contact) + "</p>" +
          bookingTimeHtml +
          attachmentsHtml +
          (transcriptHtml ? "<p>Recent conversation:</p>" + transcriptHtml : "")
      })
    });

    if (!res.ok) {
      console.error("[frontdesk lead] Resend API error:", res.status, await res.text().catch(function () { return ""; }));
      return { delivered: false, configured: true };
    }
    return { delivered: true, configured: true };
  } catch (err) {
    console.error("[frontdesk lead] Resend request failed:", err.message);
    return { delivered: false, configured: true };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendNotification, escapeHtml };
