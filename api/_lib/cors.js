// Shared by api/chat.js and api/lead.js - the two endpoints a client's own
// widget calls directly from THEIR website, so a single fixed
// ALLOWED_ORIGIN (as used by the self-serve signup endpoints, which only
// ever get called from our own site) would break every real client.
// Instead, each business's own registered domain (config.domain) is what's
// allowed, checked per-request after the businessKey resolves to a config -
// see isOriginAllowed() below.
const SITE_BASE_URL = (process.env.SITE_BASE_URL || "").replace(/\/$/, "");

// CORS itself only controls whether a BROWSER lets calling JS read the
// response - it can't stop the request from reaching this server at all,
// so the real protection is the isOriginAllowed() check below (run after
// the config is known), not this header. This just reflects the caller's
// own origin back so a legitimate browser call can actually read whatever
// this handler decides to send it (success or a 403).
function applyWidgetCors(req, res) {
  var origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

// A request with no Origin header isn't a cross-origin browser fetch to
// begin with (server-to-server, curl, same-origin) - nothing to restrict.
// Otherwise: allowed if it's our own site (previews, the demo widget) or
// matches this specific business's own registered domain. A committed
// business with no domain set yet only works from our own site - exactly
// right for a config that's never actually been installed anywhere real.
function isOriginAllowed(origin, config) {
  if (!origin) return true;
  if (SITE_BASE_URL && origin === SITE_BASE_URL) return true;
  if (config && config.domain) {
    return origin === "https://" + config.domain || origin === "https://www." + config.domain;
  }
  return false;
}

module.exports = { applyWidgetCors, isOriginAllowed };
