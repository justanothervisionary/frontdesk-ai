// Vercel serverless function - the WhatsApp channel. A visitor messages a
// business's own WhatsApp number and gets the same AI receptionist, same
// FAQ knowledge, same lead capture as the website widget (api/chat.js) -
// both channels share api/_lib/aiPrompt.js's prompt/tool definitions so
// they can never silently drift apart, and both feed the exact same
// leads list/weekly digest/CSV export via api/_lib/leadNotify.js and
// api/_lib/leadLog.js.
//
// Server-to-server only (Meta calling us), never a browser - no CORS
// headers, same as api/stripe-webhook.js. Needs the exact raw request
// bytes for signature verification (parsing and re-serializing JSON can
// change byte-for-byte formatting, which would break the check), so
// Vercel's default body parsing is disabled below, same pattern
// api/stripe-webhook.js already established for Stripe's own signature.
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { loadConfig } = require("./_lib/config");
const { createRateLimiter } = require("./_lib/rateLimit");
const { buffer } = require("./_lib/rawBody");
const { buildSystemPrompt, buildCaptureLeadTool, buildBookAppointmentTool, FLAG_UNANSWERED_TOOL } = require("./_lib/aiPrompt");
const { findBusinessKeyByWhatsAppPhoneNumberId } = require("./_lib/loginLookup");
const { getHistory, appendTurns, claimMessageId } = require("./_lib/whatsappHistory");
const { recordMissedQuestion } = require("./_lib/missedQuestions");
const { sendNotification } = require("./_lib/leadNotify");
const { appendLead } = require("./_lib/leadLog");
const { getAvailableSlots, isKnownOfferedSlot, isSlotStillFree, claimBookingSlot, createEvent, getGoogleCalendarAuth, SLOT_DURATION_MINUTES } = require("./_lib/googleCalendar");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

// Same shape as api/chat.js's own withTimeout - resolves null on either a
// slow or a rejecting promise, never throws. Duplicated rather than
// shared: it's eight lines, and keeping each webhook/endpoint file's own
// dependencies minimal is the pattern this codebase already follows
// (each rate limiter instance below is its own copy too, not shared).
function withTimeout(promise, ms) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
    promise.then(
      function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

// Keyed by senderWaId, not IP - req.headers["x-forwarded-for"] on a
// webhook is Meta's own calling IP, not the end visitor's, so an IP-keyed
// limiter here would either throttle every business's legitimate traffic
// once Meta's shared IP crosses the threshold, or do nothing to stop one
// abusive sender. Its own separate instance, same as api/lead.js already
// keeps separate from api/chat.js's.
const isSenderRateLimited = createRateLimiter(20, 60 * 1000);
const isLeadCaptureRateLimited = createRateLimiter(10, 60 * 1000);

function verifySignature(rawBody, signatureHeader) {
  if (!WHATSAPP_APP_SECRET || !signatureHeader) return false;
  var expected = "sha256=" + crypto.createHmac("sha256", WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  var a = Buffer.from(signatureHeader);
  var b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendWhatsAppReply(phoneNumberId, toWaId, text) {
  var res = await fetch("https://graph.facebook.com/" + WHATSAPP_API_VERSION + "/" + phoneNumberId + "/messages", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + WHATSAPP_ACCESS_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "text",
      text: { body: text }
    })
  });
  if (!res.ok) {
    throw new Error("WhatsApp send failed (" + res.status + "): " + await res.text().catch(function () { return ""; }));
  }
}

// Meta's one-time webhook verification handshake, done once when the
// webhook URL is first configured in Meta's App dashboard.
function handleVerify(req, res) {
  var query = req.query || {};
  var mode = query["hub.mode"];
  var token = query["hub.verify_token"];
  var challenge = query["hub.challenge"];
  if (mode === "subscribe" && WHATSAPP_VERIFY_TOKEN && token === WHATSAPP_VERIFY_TOKEN) {
    res.setHeader("Content-Type", "text/plain");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Forbidden");
}

async function handleIncoming(req, res) {
  var rawBody;
  try {
    rawBody = await buffer(req);
  } catch (err) {
    return res.status(400).send("Could not read request body");
  }

  if (!verifySignature(rawBody, req.headers["x-hub-signature-256"])) {
    console.error("[frontdesk whatsapp] signature verification failed");
    return res.status(401).send("Invalid signature");
  }

  var payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    return res.status(400).send("Invalid JSON");
  }

  // Always 200 from here on, even when there's nothing to do - this is
  // either a non-message webhook event (status callbacks like "read"/
  // "delivered" use a different shape, not an error) or something this
  // handler deliberately chooses not to act on. A non-2xx here is what
  // makes Meta retry, which should only ever happen for a genuine
  // transient failure below, not "we chose to ignore this."
  try {
    var entry = (payload.entry && payload.entry[0]) || {};
    var change = (entry.changes && entry.changes[0]) || {};
    var value = change.value || {};
    var messages = value.messages || [];
    if (!messages.length) return res.status(200).json({ ignored: true });

    var phoneNumberId = (value.metadata && value.metadata.phone_number_id) || "";
    var businessKey = findBusinessKeyByWhatsAppPhoneNumberId(phoneNumberId);
    if (!businessKey) {
      console.error("[frontdesk whatsapp] no business linked to phone_number_id:", phoneNumberId);
      return res.status(200).json({ ignored: true });
    }

    var config = loadConfig(businessKey);
    if (!config || config.active === false) {
      return res.status(200).json({ ignored: true });
    }

    for (var i = 0; i < messages.length; i++) {
      await handleOneMessage(config, businessKey, phoneNumberId, messages[i]);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[frontdesk whatsapp] handler error:", err.message);
    // Non-2xx so Meta retries later - safe to retry given claimMessageId's
    // idempotency guard runs first in handleOneMessage, before anything
    // with a visible side effect (reply sent, lead emailed) happens.
    return res.status(500).json({ error: "Internal error" });
  }
}

async function handleOneMessage(config, businessKey, phoneNumberId, message) {
  var messageId = message.id;
  var senderWaId = message.from;
  if (!messageId || !senderWaId) return;

  // The idempotency claim - must happen before ANYTHING with a visible
  // side effect (Claude call, WhatsApp send, lead notification/log).
  // Meta retries webhook deliveries on timeout/non-2xx, and unlike
  // Stripe's signature (timestamp-checked), Meta's has no replay window
  // of its own - this closes both gaps at once. A thrown error here
  // means "could not verify, do not proceed" (fail closed), not "treat
  // as new" - see the comment on claimMessageId itself.
  var claimed = await claimMessageId(businessKey, messageId);
  if (!claimed) return;

  if (isSenderRateLimited(senderWaId)) return;

  if (message.type !== "text" || !message.text || !message.text.body) {
    // Not silently dropped - a visitor who sent a photo/voice note
    // shouldn't be left hanging with no response at all.
    await sendWhatsAppReply(phoneNumberId, senderWaId, "I can only read text messages right now - could you type that out for me?").catch(function (err) {
      console.error("[frontdesk whatsapp] fallback send failed:", err.message);
    });
    return;
  }

  var userMessage = message.text.body.toString().slice(0, 1000);
  var history = await getHistory(businessKey, senderWaId);

  // Every WhatsApp sender is, by construction, a real file-backed
  // business (no free-preview path on this channel) - so unlike
  // api/chat.js, no fileConfig gate is needed here, just the calendar's
  // own connected/hours check.
  var calendarReady = !!(config.googleCalendar && config.googleCalendar.connected && config.hours);
  // Refresh token lives in Upstash, not config - see googleCalendar.js's
  // getGoogleCalendarAuth comment (GitHub's push protection rejects a
  // refresh token committed via the Contents API outright).
  var calendarAuth = calendarReady ? await getGoogleCalendarAuth(businessKey) : null;
  calendarReady = calendarReady && !!(calendarAuth && calendarAuth.refreshToken);
  var availability = calendarReady
    ? await withTimeout(getAvailableSlots(businessKey, calendarAuth.refreshToken, calendarAuth.calendarId, config.hours), 4500)
    : null;

  var systemBlocks = [
    { type: "text", text: buildSystemPrompt(config, "whatsapp"), cache_control: { type: "ephemeral" } }
  ];
  if (availability && availability.slots.length) {
    systemBlocks.push({ type: "text", text: availability.promptText });
  }

  var tools = [buildCaptureLeadTool("whatsapp"), FLAG_UNANSWERED_TOOL];
  if (availability && availability.slots.length) tools.push(buildBookAppointmentTool("whatsapp"));

  var requestOptions = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: systemBlocks,
    messages: history.concat([{ role: "user", content: userMessage }]),
    tools: tools,
    tool_choice: { type: "auto", disable_parallel_tool_use: true }
  };

  var completion = await anthropic.messages.create(requestOptions);
  var content = completion.content || [];
  var textBlock = content.find(function (b) { return b.type === "text"; });
  var captureToolUse = content.find(function (b) { return b.type === "tool_use" && b.name === "capture_lead"; });
  var flagToolUse = content.find(function (b) { return b.type === "tool_use" && b.name === "flag_unanswered"; });
  var bookToolUse = content.find(function (b) { return b.type === "tool_use" && b.name === "book_appointment"; });

  var appointmentBooked = false;
  var bookedSlotLabel = "";
  if (bookToolUse && calendarReady) {
    var requestedIso = ((bookToolUse.input && bookToolUse.input.datetime) || "").toString().trim();
    var validRequest = requestedIso && isKnownOfferedSlot(config.hours, requestedIso);
    if (validRequest) {
      var requestedEndIso = new Date(new Date(requestedIso).getTime() + SLOT_DURATION_MINUTES * 60000).toISOString();
      var locked = await claimBookingSlot(businessKey, requestedIso);
      var stillFree = locked && await withTimeout(
        isSlotStillFree(calendarAuth.refreshToken, calendarAuth.calendarId, requestedIso, requestedEndIso),
        4000
      );
      if (stillFree) {
        try {
          await createEvent(calendarAuth.refreshToken, calendarAuth.calendarId, {
            startIso: requestedIso,
            endIso: requestedEndIso,
            summary: "Appointment: " + (((bookToolUse.input && bookToolUse.input.name) || "").toString().trim() || "WhatsApp contact"),
            description: "Booked via Frontdesk AI receptionist (Sia) over WhatsApp. Contact: " + senderWaId
          });
          appointmentBooked = true;
          var matchedSlot = (availability && availability.slots || []).find(function (s) { return s.startIso === requestedIso; });
          bookedSlotLabel = matchedSlot ? matchedSlot.label : requestedIso;
        } catch (err) {
          console.error("[frontdesk whatsapp] calendar event creation failed:", businessKey, err.message);
        }
      }
    }
  }

  var reply;
  if (textBlock && textBlock.text.trim()) {
    reply = textBlock.text.trim();
  } else if (bookToolUse) {
    reply = appointmentBooked
      ? "You're booked in for " + bookedSlotLabel + " - see you then!"
      : "Sorry, that slot's just been taken - I'll pass your details to the team and they'll sort a time with you directly.";
  } else if (captureToolUse) {
    reply = "Thanks - I've got that, someone from the team will be in touch.";
  } else {
    reply = config.fallbackAnswer;
  }

  await sendWhatsAppReply(phoneNumberId, senderWaId, reply);
  await appendTurns(businessKey, senderWaId, userMessage, reply);

  if (flagToolUse) {
    recordMissedQuestion(businessKey, userMessage).catch(function () {});
  }

  if (captureToolUse && !isLeadCaptureRateLimited(senderWaId)) {
    // Contact is ALWAYS the sender's own wa_id - server-supplied, never
    // trusting whatever the model's tool call contains, the same
    // discipline flag_unanswered already applies to the question text.
    var capturedName = ((captureToolUse.input && captureToolUse.input.name) || "").toString().trim().slice(0, 200);
    var transcript = history.concat([
      { role: "user", content: userMessage },
      { role: "assistant", content: reply }
    ]).slice(-6);
    await Promise.all([
      sendNotification(config, { name: capturedName || "WhatsApp contact", contact: senderWaId, transcript: transcript, source: "whatsapp" }),
      appendLead(businessKey, { name: capturedName || "WhatsApp contact", contact: senderWaId, transcript: transcript, source: "whatsapp" }).catch(function (err) {
        console.error("[frontdesk whatsapp] failed to log captured lead:", businessKey, err.message);
      })
    ]);
  }

  if (bookToolUse) {
    var bookedName = ((bookToolUse.input && bookToolUse.input.name) || "").toString().trim().slice(0, 200);
    var bookingTranscript = history.concat([
      { role: "user", content: userMessage },
      { role: "assistant", content: reply }
    ]).slice(-6);
    var bookingLead = {
      name: bookedName || "WhatsApp contact",
      contact: senderWaId,
      transcript: bookingTranscript,
      source: appointmentBooked ? "whatsapp-booking" : "whatsapp-booking-attempt",
      bookingTime: appointmentBooked ? bookedSlotLabel : undefined
    };
    await Promise.all([
      sendNotification(config, bookingLead),
      appendLead(businessKey, bookingLead).catch(function (err) {
        console.error("[frontdesk whatsapp] failed to log booking:", businessKey, err.message);
      })
    ]);
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") return handleVerify(req, res);
  if (req.method === "POST") return handleIncoming(req, res);
  return res.status(405).end();
};

module.exports.config = { api: { bodyParser: false } };
