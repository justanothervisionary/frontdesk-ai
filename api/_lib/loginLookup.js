// Finds which business a login email belongs to. There's no email-index
// anywhere in this codebase - configs are keyed by businessKey, not email -
// so this scans every config, same full-scan pattern api/weekly-digest.js
// already runs on a cron. That's local disk (listBusinessKeys() +
// loadConfig(), zero network I/O), so it's a non-issue at the "a handful to
// dozens of clients" scale this project is at; if that ever changes, a
// small api/_private-configs/email-index.json maintained alongside every
// write would turn this into an O(1) lookup, but building that now would be
// solving a problem that doesn't exist yet.
const { loadConfig, listBusinessKeys } = require("./config");

// Only a business that actually paid (has a stripeCustomerId, set solely
// by api/stripe-webhook.js on a genuine checkout) can ever get a session -
// this is what keeps a hand-built outreach/demo config like dentistw4.json
// (no Stripe linkage at all) from ever logging in. `active` is
// deliberately NOT required here, unlike api/weekly-digest.js's filter - a
// cancelled business should still be able to log in to see old leads or
// reactivate billing via the Stripe Portal, not be locked out entirely.
function findBusinessKeyByEmail(email) {
  var target = email.trim().toLowerCase();
  var keys = listBusinessKeys();
  for (var i = 0; i < keys.length; i++) {
    var config = loadConfig(keys[i]);
    if (!config || !config.notifyEmail || !config.stripeCustomerId) continue;
    if (config.notifyEmail.trim().toLowerCase() === target) return keys[i];
  }
  return null;
}

// Resolves an incoming WhatsApp webhook's phone_number_id back to the
// business it belongs to - same full-scan-via-loadConfig pattern as
// findBusinessKeyByEmail above (loadConfig is a synchronous local read,
// the same cost class api/chat.js already pays per message today, just
// O(n) instead of O(1) - dwarfed by the Anthropic call that follows
// either way, fine at this project's "dozens of clients" scale).
// Deliberately does NOT require stripeCustomerId the way the email
// lookup does - that requirement exists there to gate real account/
// session access, but this only determines which business's FAQ content
// answers a message, so testing against a demo/outreach config before a
// client's gone through real Stripe checkout is fine.
function findBusinessKeyByWhatsAppPhoneNumberId(phoneNumberId) {
  var target = (phoneNumberId || "").toString().trim();
  if (!target) return null;
  var keys = listBusinessKeys();
  for (var i = 0; i < keys.length; i++) {
    var config = loadConfig(keys[i]);
    if (!config || !config.whatsapp || !config.whatsapp.phoneNumberId) continue;
    if (config.whatsapp.phoneNumberId === target) return keys[i];
  }
  return null;
}

module.exports = { findBusinessKeyByEmail, findBusinessKeyByWhatsAppPhoneNumberId };
