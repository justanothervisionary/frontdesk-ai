// Two Upstash-backed concerns for api/whatsapp.js, both using the same
// shared pipeline() helper api/_lib/usage.js and api/_lib/missedQuestions.js
// already use - but each needs something neither of those did:
//
// 1. Conversation history. Unlike the website widget (which keeps history
//    client-side in the browser and resends it every request), a WhatsApp
//    sender has no "client" maintaining state - the server has to remember
//    recent turns per (businessKey, sender) itself for the AI to have any
//    context across messages. Unlike usage.js/missedQuestions.js's small,
//    FIXED set of keys per business, a key per unique sender who ever
//    texts a client would be a brand-new permanent key forever with no
//    TTL anywhere - an unbounded storage leak neither of those patterns
//    has. Every write here refreshes an EXPIRE instead.
//
// 2. Idempotency. Meta retries webhook deliveries on timeout or a non-2xx
//    response, the same category of behaviour api/stripe-webhook.js
//    already guards against for Stripe - but unlike Stripe's signature
//    (which embeds a timestamp constructEvent checks against a tolerance
//    window), Meta's X-Hub-Signature-256 is a bare HMAC with no
//    timestamp/nonce, so a retried (or captured-and-replayed) payload has
//    no built-in expiry either. claimMessageId() closes both gaps at
//    once with one atomic claim per message id.
const { pipeline, isConfigured } = require("./upstash");

var MAX_TURNS = 6;
var HISTORY_TTL_SECONDS = 48 * 60 * 60; // 48h of inactivity - refreshed on every append, not a hard cap on conversation age
var DEDUP_TTL_SECONDS = 24 * 60 * 60; // comfortably longer than any realistic Meta retry window

function historyKey(businessKey, waId) {
  return "wa-history:" + businessKey + ":" + waId;
}

function dedupKey(businessKey, messageId) {
  return "wa-dedup:" + businessKey + ":" + messageId;
}

// Never throws - returns [] on any failure or missing config, same
// contract api/_lib/usage.js's getUsage() already has. Unlike getUsage()
// (read-only side-channel data for the dashboard), this feeds directly
// into the Claude call on the critical path - an Upstash hiccup must
// degrade to "treat as a fresh conversation," never break the reply.
//
// Known, accepted limitation: two rapid-fire messages from the same
// sender can each read history before the other's turn is appended,
// producing a contextless reply or slightly out-of-order history - a
// bounded quality issue, not corruption, not worth a per-sender lock
// for v1.
async function getHistory(businessKey, waId) {
  if (!isConfigured()) return [];
  try {
    var result = await pipeline([["LRANGE", historyKey(businessKey, waId), 0, MAX_TURNS - 1]]);
    var raw = (result[0] && result[0].result) || [];
    // LPUSH stores newest-first; conversation order needs oldest-first.
    return raw.map(function (s) {
      try { return JSON.parse(s); } catch (e) { return null; }
    }).filter(Boolean).reverse();
  } catch (err) {
    console.error("[frontdesk whatsappHistory] getHistory failed:", businessKey, err.message);
    return [];
  }
}

// Fire-and-forget safe (never throws) - appends both turns of one
// exchange in a single pipeline call.
async function appendTurns(businessKey, waId, userMessage, assistantReply) {
  if (!isConfigured()) return;
  try {
    var key = historyKey(businessKey, waId);
    await pipeline([
      ["LPUSH", key, JSON.stringify({ role: "assistant", content: assistantReply })],
      ["LPUSH", key, JSON.stringify({ role: "user", content: userMessage })],
      ["LTRIM", key, 0, MAX_TURNS - 1],
      ["EXPIRE", key, HISTORY_TTL_SECONDS]
    ]);
  } catch (err) {
    console.error("[frontdesk whatsappHistory] appendTurns failed:", businessKey, err.message);
  }
}

// Atomic claim via SET NX - returns true the FIRST time a given
// (businessKey, messageId) pair is seen, false on every retry/replay
// after that. Must be called, and must return true, before any
// Claude/Graph-API/lead-notification work happens - this is what makes
// the whole handler safe to retry from Meta's side without double-
// sending a reply or double-emailing a lead. Deliberately NOT wrapped
// in a "never throws" contract like getHistory/appendTurns: unlike
// those, a failure here must NOT silently fall through to "treat as new
// message" (that would defeat the entire point), so the caller is
// expected to treat a thrown error as "could not verify, do not
// proceed" - see api/whatsapp.js.
async function claimMessageId(businessKey, messageId) {
  if (!isConfigured()) {
    // No Upstash configured = no idempotency possible. Fail closed
    // (treat as already claimed / do nothing) rather than fail open
    // (process every retry as a brand new message) - a missed reply is
    // recoverable (the visitor just messages again), a business getting
    // three lead emails for one enquiry is not a good first impression.
    console.error("[frontdesk whatsappHistory] claimMessageId: Upstash not configured - refusing to process to avoid duplicate sends");
    return false;
  }
  var result = await pipeline([["SET", dedupKey(businessKey, messageId), "1", "NX", "EX", DEDUP_TTL_SECONDS]]);
  return !!(result[0] && result[0].result);
}

module.exports = { getHistory, appendTurns, claimMessageId };
