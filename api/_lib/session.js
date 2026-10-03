// The first auth/session code in this codebase - deliberately not a JWT
// library or password/user table, just Node's built-in `crypto` doing
// HMAC-SHA256 over a small signed payload. Two uses of the same primitive:
// a short-lived one-time login token (emailed) and a long-lived session
// cookie (set after that token is confirmed). Requires SESSION_SECRET.
const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || "";
// __Host- is a real (free) hardening: browsers only accept it over HTTPS,
// scoped to Path=/, with no Domain attribute - it can't be set by a
// subdomain or leak to one, unlike a plain cookie name.
const SESSION_COOKIE_NAME = "__Host-session";
// A separate cookie name (not just a different payload under the same
// cookie) so a business session and an admin session can never be confused
// by anything reading the wrong header - each is only ever looked for
// under its own name.
const ADMIN_SESSION_COOKIE_NAME = "__Host-admin-session";
const LOGIN_TOKEN_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function base64url(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToStr(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf8");
}
function hmac(input) {
  return crypto.createHmac("sha256", SECRET).update(input).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload, ttlSeconds) {
  if (!SECRET) throw new Error("SESSION_SECRET is not configured");
  var body = base64url(JSON.stringify(Object.assign({}, payload, {
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  })));
  return body + "." + hmac(body);
}

// Timing-safe signature check, then expiry check. Returns the payload or
// null - never throws, so callers can treat any bad/expired/tampered
// token as "not logged in" without a try/catch at every call site.
function verify(token) {
  if (!SECRET || typeof token !== "string") return null;
  var parts = token.split(".");
  if (parts.length !== 2) return null;
  var body = parts[0], sig = parts[1];
  var expected = hmac(body);
  var a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  var payload;
  try { payload = JSON.parse(base64urlToStr(body)); } catch (e) { return null; }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function signLoginToken(businessKey) {
  return sign({ businessKey: businessKey, purpose: "login" }, LOGIN_TOKEN_TTL_SECONDS);
}

// Returns the businessKey, or null if the token is missing/expired/wrong
// purpose - deliberately checks `purpose` so a leaked login-email token
// can never be replayed as a session cookie or vice versa.
function verifyLoginToken(token) {
  var payload = verify(token);
  return (payload && payload.purpose === "login" && payload.businessKey) ? payload.businessKey : null;
}

function parseCookies(req) {
  var header = req.headers.cookie || "";
  var out = {};
  header.split(";").forEach(function (part) {
    var idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function getSessionBusinessKey(req) {
  var token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token) return null;
  var payload = verify(token);
  return (payload && payload.purpose === "session" && payload.businessKey) ? payload.businessKey : null;
}

// impersonatedBy is optional - set only when an admin is minting this
// session on a business's behalf (see api/dashboard.js's admin-impersonate
// action), never by a real login. Baked into the signed payload itself,
// not inferred from "is an admin cookie also present" - that side-channel
// would wrongly fire for a real business owner who ALSO happens to be an
// admin logged in separately, which isn't impersonation at all.
function setSessionCookie(res, businessKey, impersonatedBy) {
  var payload = { businessKey: businessKey, purpose: "session" };
  if (impersonatedBy) payload.impersonatedBy = impersonatedBy;
  var token = sign(payload, SESSION_TTL_SECONDS);
  res.setHeader("Set-Cookie",
    SESSION_COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_TTL_SECONDS);
}

// Null when this session was a normal login, or no valid session at all -
// otherwise the admin email that minted it via impersonation. Mirrors
// getSessionBusinessKey()'s own cookie-parse-and-verify shape.
function getSessionImpersonator(req) {
  var token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token) return null;
  var payload = verify(token);
  return (payload && payload.purpose === "session" && payload.impersonatedBy) ? payload.impersonatedBy : null;
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", SESSION_COOKIE_NAME + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
}

// Founder/ops access, not a business - a comma-separated allowlist (env
// var, not a file/database - there's never going to be more than a
// handful of these) rather than anything resembling a user table.
function isAdminEmail(email) {
  var list = (process.env.ADMIN_EMAILS || "").split(",")
    .map(function (e) { return e.trim().toLowerCase(); })
    .filter(Boolean);
  return list.indexOf((email || "").trim().toLowerCase()) !== -1;
}

function signAdminLoginToken(email) {
  return sign({ email: email, purpose: "admin-login" }, LOGIN_TOKEN_TTL_SECONDS);
}

function verifyAdminLoginToken(token) {
  var payload = verify(token);
  return (payload && payload.purpose === "admin-login" && payload.email) ? payload.email : null;
}

function setAdminSessionCookie(res, email) {
  var token = sign({ email: email, purpose: "admin-session" }, SESSION_TTL_SECONDS);
  res.setHeader("Set-Cookie",
    ADMIN_SESSION_COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_TTL_SECONDS);
}

// Re-checks isAdminEmail() against the CURRENT env var on every request,
// rather than just trusting whatever was true when the token was signed -
// unlike a business session (where even a cancelled business should still
// be able to log in), pulling someone off ADMIN_EMAILS should take effect
// immediately, not after their existing session happens to expire up to
// 30 days later.
function getSessionAdminEmail(req) {
  var token = parseCookies(req)[ADMIN_SESSION_COOKIE_NAME];
  if (!token) return null;
  var payload = verify(token);
  if (!payload || payload.purpose !== "admin-session" || !payload.email) return null;
  return isAdminEmail(payload.email) ? payload.email : null;
}

function clearAdminSessionCookie(res) {
  res.setHeader("Set-Cookie", ADMIN_SESSION_COOKIE_NAME + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
}

module.exports = {
  signLoginToken, verifyLoginToken, setSessionCookie, getSessionBusinessKey, getSessionImpersonator, clearSessionCookie,
  isAdminEmail, signAdminLoginToken, verifyAdminLoginToken, setAdminSessionCookie, getSessionAdminEmail, clearAdminSessionCookie
};
