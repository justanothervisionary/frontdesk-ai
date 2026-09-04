// Best-effort event log for the weekly digest (api/weekly-digest.js) - one
// small JSON file per business under api/_private-configs/leads/, never
// publicly reachable (anything under api/ is never served as a static
// file by Vercel - see the matching reasoning for notifyEmail in
// api/_lib/config.js).
//
// Reuses the existing GitHub-Contents-API pattern (api/_lib/github.js)
// rather than adding a new datastore. That's a reasonable fit here because
// leads are rare - a commit per lead is the same order of magnitude as the
// commits this project already makes for signups/cancellations. It would
// NOT be a reasonable fit for something as frequent as every chat message;
// see api/weekly-digest.js for why chat volume isn't tracked this way.
const { getFile, putFile } = require("./github");

function logPath(businessKey) {
  return "api/_private-configs/leads/" + businessKey + ".json";
}

var MAX_AGE_DAYS = 35; // ~5 weeks - keeps the file bounded with no separate cleanup job

function pruneOld(entries) {
  var cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter(function (e) { return new Date(e.at).getTime() >= cutoff; });
}

// Called from api/lead.js alongside (in parallel with) the real Resend
// notification - a failure here must never break that, since the visitor
// is relying on the notification, not this bookkeeping. Callers should
// swallow rejections rather than let them affect the visitor-facing
// response.
async function appendLead(businessKey, lead) {
  var existing = await getFile(logPath(businessKey));
  var entries = existing ? pruneOld(JSON.parse(existing.content)) : [];
  entries.push({ name: lead.name, contact: lead.contact, at: new Date().toISOString() });
  await putFile(logPath(businessKey), entries, "Log lead for " + businessKey + "'s weekly digest", existing && existing.sha);
}

// thisWeek: entries from the last 7 days, for the digest email itself.
// all/prunedCount: so the caller (api/weekly-digest.js) can write back a
// trimmed file when pruning actually removed something, instead of
// generating a pointless weekly commit for a business with no old leads.
async function readLeads(businessKey) {
  var existing = await getFile(logPath(businessKey));
  if (!existing) return { all: [], thisWeek: [], sha: null, prunedCount: 0 };
  var rawEntries = JSON.parse(existing.content);
  var entries = pruneOld(rawEntries);
  var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var thisWeek = entries.filter(function (e) { return new Date(e.at).getTime() >= weekAgo; });
  return { all: entries, thisWeek: thisWeek, sha: existing.sha, prunedCount: rawEntries.length - entries.length };
}

function writePrunedLeads(businessKey, entries, sha) {
  return putFile(logPath(businessKey), entries, "Prune old leads for " + businessKey, sha);
}

module.exports = { appendLead, readLeads, writePrunedLeads };
