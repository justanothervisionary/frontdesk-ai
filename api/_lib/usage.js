// Per-business usage counters (message count, input/output tokens) for the
// admin dashboard. Deliberately NOT the git-commit-as-database pattern the
// rest of this project uses (configs, leads) - that's a reasonable fit for
// something as rare as a lead, but a chat message happens on every single
// visitor turn, and a commit per message would mean constant write
// conflicts under concurrent invocations plus unbounded repo growth. This
// talks to Upstash Redis's plain REST API instead (api/_lib/upstash.js) -
// a genuinely new piece of infrastructure, added specifically for this.
//
// All-time counters only for v1 - three keys per business, no daily/trend
// buckets yet. That's "basic info to begin with", not a permanent design
// decision; a time-series view is a natural fast-follow once there's real
// volume to make one worth looking at.
const { pipeline, isConfigured } = require("./upstash");

function keysFor(businessKey) {
  return {
    messages: "usage:" + businessKey + ":messages",
    inputTokens: "usage:" + businessKey + ":inputTokens",
    outputTokens: "usage:" + businessKey + ":outputTokens"
  };
}

// Fire-and-forget from the caller's side (api/chat.js does NOT await this) -
// never throws, so it can never affect the visitor-facing chat response.
// Silently does nothing if Upstash isn't configured yet, same "not
// configured" handling already used for RESEND_API_KEY elsewhere.
async function recordUsage(businessKey, usage) {
  if (!isConfigured()) return;
  try {
    var k = keysFor(businessKey);
    var inputTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    var outputTokens = usage.output_tokens || 0;
    await pipeline([
      ["INCRBY", k.messages, 1],
      ["INCRBY", k.inputTokens, inputTokens],
      ["INCRBY", k.outputTokens, outputTokens]
    ]);
  } catch (err) {
    console.error("[frontdesk usage] recordUsage failed:", businessKey, err.message);
  }
}

// Never throws - always returns zeros on any failure or missing config, so
// a caller (api/dashboard.js's admin-list, scanning every business) never
// needs its own special-casing around this beyond its own per-business
// try/catch for everything else.
async function getUsage(businessKey) {
  var zero = { messages: 0, inputTokens: 0, outputTokens: 0 };
  if (!isConfigured()) return zero;
  try {
    var k = keysFor(businessKey);
    var result = await pipeline([["GET", k.messages], ["GET", k.inputTokens], ["GET", k.outputTokens]]);
    return {
      messages: Number((result[0] && result[0].result) || 0),
      inputTokens: Number((result[1] && result[1].result) || 0),
      outputTokens: Number((result[2] && result[2].result) || 0)
    };
  } catch (err) {
    console.error("[frontdesk usage] getUsage failed:", businessKey, err.message);
    return zero;
  }
}

module.exports = { recordUsage, getUsage };
