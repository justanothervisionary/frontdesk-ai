// Reads the exact raw request bytes before Vercel's default JSON body
// parsing touches them - needed anywhere a webhook's signature is
// verified over the raw payload (parsing and re-serializing JSON can
// change byte-for-byte formatting, which would break the signature
// check). Extracted from api/stripe-webhook.js so api/whatsapp.js can
// reuse the same implementation rather than a second copy - callers
// still need their own `module.exports.config = { api: { bodyParser:
// false } }` to actually disable Vercel's parsing, this just does the
// reading once that's done.
async function buffer(readable) {
  var chunks = [];
  for await (var chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { buffer };
