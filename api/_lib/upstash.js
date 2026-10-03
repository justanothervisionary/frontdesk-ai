// Shared Upstash Redis REST pipeline helper - extracted from usage.js once
// api/_lib/missedQuestions.js needed the exact same fetch/timeout/
// AbortController plumbing, rather than a second copy of it.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
const FETCH_TIMEOUT_MS = 1500;

function isConfigured() {
  return !!(UPSTASH_URL && UPSTASH_TOKEN);
}

// A short hard timeout so a slow or down Upstash instance can never hang a
// caller indefinitely, regardless of how it's invoked - this is what makes
// it safe for a caller to fire-and-forget this.
async function pipeline(commands) {
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var res = await fetch(UPSTASH_URL + "/pipeline", {
      method: "POST",
      headers: { "Authorization": "Bearer " + UPSTASH_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: controller.signal
    });
    if (!res.ok) throw new Error("Upstash pipeline failed: " + res.status);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { pipeline, isConfigured };
