// Business keys double as public config filenames and the `data-business`
// attribute a client's site exposes in its own page source - not secret,
// but must not be sequential/guessable ("client1", "client2", ...) since
// that would make it trivial to enumerate other businesses' configs.
const crypto = require("crypto");
const { getFile } = require("./github");

function slugify(name) {
  return (name || "business")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "business";
}

async function generateUniqueBusinessKey(businessName) {
  var base = slugify(businessName);
  for (var attempt = 0; attempt < 5; attempt++) {
    var suffix = crypto.randomBytes(3).toString("hex");
    var key = base + "-" + suffix;
    var existing = await getFile("configs/" + key + ".json");
    if (!existing) return key;
  }
  throw new Error("Could not generate a unique business key after 5 attempts");
}

module.exports = { slugify, generateUniqueBusinessKey };
