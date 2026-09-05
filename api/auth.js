// Vercel serverless function - combines what were three separate
// endpoints (request-login, verify-login, logout) into one file, dispatched
// by ?action=. Purely a Vercel Hobby-plan constraint, not a design choice:
// the Hobby plan caps a deployment at 12 Serverless Functions, and this
// project's endpoint count crossed that the moment the dashboard/login
// feature was added (confirmed via the actual failed deployment's error:
// "exceeded_serverless_functions_per_deployment"). No behavior changed
// from the original three files - just merged into one, routed by action.
const { createRateLimiter } = require("./_lib/rateLimit");
const { findBusinessKeyByEmail } = require("./_lib/loginLookup");
const { signLoginToken, verifyLoginToken, setSessionCookie, clearSessionCookie } = require("./_lib/session");
const { isTrustedOrigin } = require("./_lib/cors");

const isRateLimited = createRateLimiter(5, 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://frontdesk-ai-chi-ten.vercel.app";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function sendLoginEmail(email, businessKey) {
  var token = signLoginToken(businessKey);
  var link = SITE_BASE_URL + "/api/auth?action=verify&token=" + encodeURIComponent(token);
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: email,
      subject: "Log in to Frontdesk",
      html:
        "<p>Click below to log in to your Frontdesk dashboard. This link expires in 15 minutes and can only be used once.</p>" +
        "<p><a href=\"" + link + "\">Log in to Frontdesk</a></p>" +
        "<p style=\"color:#888;font-size:12px;\">If you didn't request this, you can safely ignore this email.</p>"
    })
  });
  if (!res.ok) throw new Error("Resend API error " + res.status + ": " + await res.text().catch(function () { return ""; }));
}

async function handleRequestLogin(req, res) {
  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests - please try again in a minute." });
  }

  var email = ((req.body || {}).email || "").toString().trim().slice(0, 200);
  // Always the same generic response regardless of what happens below -
  // never confirm or deny whether an email is a registered business.
  var GENERIC_RESPONSE = { received: true, message: "If that email is registered, a login link is on its way." };

  if (!EMAIL_RE.test(email)) return res.status(200).json(GENERIC_RESPONSE);

  try {
    var businessKey = findBusinessKeyByEmail(email);
    if (businessKey && RESEND_API_KEY) {
      await sendLoginEmail(email, businessKey);
    } else if (businessKey) {
      console.log("[frontdesk auth] Resend not configured - login link not sent for", businessKey);
    }
  } catch (err) {
    console.error("[frontdesk auth] request-login error:", err.message);
  }

  return res.status(200).json(GENERIC_RESPONSE);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function confirmPageHtml(token, error) {
  return "<!DOCTYPE html><html><head><meta charset=\"UTF-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />" +
    "<title>Log in to Frontdesk</title><style>" +
    "body{margin:0;background:#0a0b0d;color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
    "display:flex;align-items:center;justify-content:center;min-height:100vh;}" +
    ".card{background:#14161a;border:1px solid #22262d;border-radius:16px;padding:32px;max-width:360px;text-align:center;}" +
    "h1{font-size:18px;margin:0 0 12px;}p{color:#9aa1ac;font-size:14px;line-height:1.5;margin:0 0 20px;}" +
    "button{background:#35d68f;color:#04160c;border:none;border-radius:9px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;}" +
    "</style></head><body><div class=\"card\">" +
    (error
      ? "<h1>Link expired</h1><p>" + escapeHtml(error) + " Request a new login link from the login page.</p>"
      : "<h1>Confirm it's you</h1><p>Click below to finish logging in to your Frontdesk dashboard.</p>" +
        "<form method=\"POST\" action=\"/api/auth?action=verify\">" +
        "<input type=\"hidden\" name=\"token\" value=\"" + escapeHtml(token) + "\" />" +
        "<button type=\"submit\">Log in to Frontdesk</button></form>") +
    "</div></body></html>";
}

// GET renders a plain "click to confirm" page rather than logging in
// immediately - many business email providers (Microsoft 365's Safe
// Links, among others) auto-fetch every URL in an incoming email to scan
// it before a human opens it, which would burn a single-use token before
// the real click ever happens. Only the POST below (an actual click)
// consumes the token.
function handleVerifyGet(req, res) {
  var token = (req.query && req.query.token) || "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!token) return res.status(400).send(confirmPageHtml("", "That login link looks incomplete."));
  return res.status(200).send(confirmPageHtml(token, null));
}

function handleVerifyPost(req, res) {
  var body = req.body || {};
  var submittedToken = (body.token || "").toString();
  var businessKey = verifyLoginToken(submittedToken);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!businessKey) {
    return res.status(400).send(confirmPageHtml("", "That login link has expired or was already used."));
  }
  setSessionCookie(res, businessKey);
  res.setHeader("Location", "/site/dashboard.html");
  return res.status(302).end();
}

function handleLogout(req, res) {
  if (!isTrustedOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  clearSessionCookie(res);
  return res.status(200).json({ loggedOut: true });
}

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || "";

  // The verify page (GET, from an emailed link) is the one path that
  // isn't a same-origin fetch call, so it's exempt from the
  // ALLOWED_ORIGIN/CORS headers below - a visitor's own mail client is
  // opening it directly, not our own site's JS.
  if (action === "verify") {
    if (req.method === "GET") return handleVerifyGet(req, res);
    if (req.method === "POST") return handleVerifyPost(req, res);
    return res.status(405).end();
  }

  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (action === "logout") return handleLogout(req, res);
  if (action === "request" || !action) return handleRequestLogin(req, res);
  return res.status(400).json({ error: "Unknown action" });
};
