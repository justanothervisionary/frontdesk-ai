// Vercel serverless function - clears the dashboard session cookie.
// Not itemized in the original plan but a necessary companion to login:
// without it there'd be no way to end a session on a shared computer.
const { clearSessionCookie } = require("./_lib/session");
const { isTrustedOrigin } = require("./_lib/cors");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isTrustedOrigin(req)) return res.status(403).json({ error: "Forbidden" });
  clearSessionCookie(res);
  return res.status(200).json({ loggedOut: true });
};
