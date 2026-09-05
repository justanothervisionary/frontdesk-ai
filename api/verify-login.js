// Vercel serverless function - step 2 of magic-link login.
//
// GET (what the emailed link points at) renders a plain "click to confirm"
// page rather than immediately consuming the token. This matters in
// practice, not just in theory: a large share of UK small businesses run
// Microsoft 365 with Safe Links, which auto-fetches every URL in an
// incoming email before a human ever opens it, purely to scan it. A bare
// GET that consumed the token on load would get silently burned by that
// scan, and the real user's actual click would hit an already-used link -
// a genuine, common magic-link failure mode in exactly this market.
//
// Only the POST below (triggered by an actual click on that page's form)
// validates+consumes the token and sets the session cookie.
const { verifyLoginToken, setSessionCookie } = require("./_lib/session");

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
        "<form method=\"POST\" action=\"/api/verify-login\">" +
        "<input type=\"hidden\" name=\"token\" value=\"" + escapeHtml(token) + "\" />" +
        "<button type=\"submit\">Log in to Frontdesk</button></form>") +
    "</div></body></html>";
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    var token = (req.query && req.query.token) || "";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!token) return res.status(400).send(confirmPageHtml("", "That login link looks incomplete."));
    // Deliberately does NOT verify the token yet - just renders the
    // confirm form. Verifying here (even without consuming) would still
    // mean a prefetch scanner learns whether a token is currently valid;
    // rendering unconditionally avoids that entirely.
    return res.status(200).send(confirmPageHtml(token, null));
  }

  if (req.method === "POST") {
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

  return res.status(405).end();
};
