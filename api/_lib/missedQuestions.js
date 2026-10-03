// Questions the AI couldn't answer from a business's own FAQ content -
// the feedback loop that shows a business what's missing from their own
// knowledge base. Deliberately NOT the git-commit pattern api/_lib/leadLog.js
// uses for leads: a missed question is lower-value and plausibly far more
// frequent than a lead (every fallback-triggered turn, not just a real
// conversion) - the same "too frequent for git" problem api/_lib/usage.js's
// own comment explains is why IT talks to Upstash instead of a commit per
// event. This does the same, via the shared pipeline helper.
//
// A capped list via LPUSH+LTRIM, not a time-based prune: LPUSH already
// keeps it newest-first, and capping by count bounds storage with no
// separate cleanup job needed.
const { pipeline, isConfigured } = require("./upstash");

var MAX_ENTRIES = 150;

function keyFor(businessKey) {
  return "missed:" + businessKey;
}

// Fire-and-forget from api/chat.js - never throws, never awaited. Losing an
// occasional entry here is fine; it must never add latency to a visitor's
// reply the way a lost lead would matter.
async function recordMissedQuestion(businessKey, question) {
  if (!isConfigured()) return;
  var text = (question || "").toString().trim().slice(0, 500);
  if (!text) return;
  try {
    var entry = JSON.stringify({ question: text, at: new Date().toISOString() });
    var key = keyFor(businessKey);
    await pipeline([
      ["LPUSH", key, entry],
      ["LTRIM", key, 0, MAX_ENTRIES - 1]
    ]);
  } catch (err) {
    console.error("[frontdesk missedQuestions] recordMissedQuestion failed:", businessKey, err.message);
  }
}

// Never throws - returns [] on any failure or missing config, same
// zero-special-casing contract as api/_lib/usage.js's getUsage().
async function getMissedQuestions(businessKey, limit) {
  if (!isConfigured()) return [];
  try {
    var result = await pipeline([["LRANGE", keyFor(businessKey), 0, (limit || 20) - 1]]);
    var raw = (result[0] && result[0].result) || [];
    return raw.map(function (s) {
      try { return JSON.parse(s); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.error("[frontdesk missedQuestions] getMissedQuestions failed:", businessKey, err.message);
    return [];
  }
}

module.exports = { recordMissedQuestion, getMissedQuestions };
