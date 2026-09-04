// Target of vercel.json's rewrite for /configs/private/* - that directory
// holds real businesses' contact emails and must never be reachable over
// the public internet (see api/_lib/config.js for how the server reads it
// instead, directly off disk, with no HTTP request involved).
module.exports = function handler(req, res) {
  res.status(404).json({ error: "Not found" });
};
