// Best-effort, in-memory per-IP rate limiter shared by every endpoint below.
// Resets on cold start and isn't shared across serverless instances - a
// reasonable first safety net, not a guaranteed one under sustained abuse.
// The real backstops are provider-side (Anthropic spend cap, Stripe's own
// abuse detection) - see SECURITY.md.
function createRateLimiter(maxPerWindow, windowMs) {
  var requestLog = new Map();
  return function isRateLimited(ip) {
    var now = Date.now();
    var entry = requestLog.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    requestLog.set(ip, entry);
    return entry.count > maxPerWindow;
  };
}

module.exports = { createRateLimiter };
