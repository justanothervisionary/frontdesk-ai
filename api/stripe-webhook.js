// Vercel serverless function - Stripe calls this directly (server-to-server,
// never from a browser), so no CORS headers here at all.
//
// Two Stripe gotchas that matter a lot for this one file:
// 1. Signature verification needs the EXACT raw request bytes - Vercel's
//    default JSON body parsing would silently break it, so it's disabled
//    below via `module.exports.config`.
// 2. Stripe may deliver the same event more than once (retries on timeout/
//    non-2xx). Every handler here is written to be a safe no-op on a
//    repeat delivery - see the idempotency checks inline.
const Stripe = require("stripe");
const { getFile, putFile } = require("./_lib/github");
const { buildConfigFromDraft } = require("./_lib/config");

// See api/create-checkout.js for why this is lazy rather than constructed
// eagerly at module load.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

async function buffer(readable) {
  var chunks = [];
  for await (var chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function handleCheckoutCompleted(session) {
  var businessKey = session.metadata && session.metadata.businessKey;
  if (!businessKey) {
    console.error("[frontdesk webhook] checkout.session.completed missing businessKey metadata, session:", session.id);
    return;
  }

  var filePath = "configs/" + businessKey + ".json";
  var existing = await getFile(filePath);
  if (existing) {
    var existingConfig = JSON.parse(existing.content);
    if (existingConfig.stripeCheckoutSessionId === session.id) {
      console.log("[frontdesk webhook] duplicate delivery for", businessKey, "- no-op");
      return; // Stripe retry of an event we've already processed
    }
    // Collision odds are near-zero given generateUniqueBusinessKey() checks
    // for this at creation time, but never overwrite an existing live
    // client's config just because of a race.
    console.error("[frontdesk webhook] config already exists for", businessKey, "under a different session - refusing to overwrite");
    return;
  }

  // extraInfo travels as a short reference (extraInfoId), not raw text -
  // see api/upload-draft-text.js for why (Stripe metadata's 500-char
  // value limit). Resolve it back to the real text here, before handing
  // off to the same buildFrontdeskConfig() the free preview uses.
  var draft = Object.assign({}, session.metadata);
  var extraInfoId = draft.extraInfoId;
  delete draft.extraInfoId;
  if (extraInfoId && /^[0-9a-f]{24}\.txt$/i.test(extraInfoId)) {
    var draftTextFile = await getFile("configs/drafts/" + extraInfoId);
    if (draftTextFile) draft.extraInfo = draftTextFile.content;
  }

  var config = buildConfigFromDraft(draft);
  if (!config) {
    console.error("[frontdesk webhook] could not build a valid config for", businessKey, "from session", session.id);
    return;
  }

  config.notifyEmail = (session.customer_details && session.customer_details.email) || config.notifyEmail;
  config.active = true;
  config.stripeCustomerId = session.customer;
  config.stripeSubscriptionId = session.subscription;
  config.stripeCheckoutSessionId = session.id;

  await putFile(filePath, config, "Publish config for " + businessKey + " (auto-published via Stripe trial signup)");
  console.log("[frontdesk webhook] published new config for", businessKey);
}

async function setActiveFlag(subscription, active) {
  var businessKey = subscription.metadata && subscription.metadata.businessKey;
  if (!businessKey) {
    console.error("[frontdesk webhook] subscription event missing businessKey metadata, subscription:", subscription.id);
    return;
  }

  var filePath = "configs/" + businessKey + ".json";
  var existing = await getFile(filePath);
  if (!existing) {
    // checkout.session.completed for this business may not have landed yet
    // (Stripe doesn't guarantee webhook delivery order) - nothing to flip.
    console.error("[frontdesk webhook] no config found for", businessKey, "- nothing to update");
    return;
  }

  var config = JSON.parse(existing.content);
  if (config.active === active) return; // already correct - idempotent no-op

  config.active = active;
  await putFile(filePath, config, (active ? "Reactivate " : "Deactivate ") + businessKey, existing.sha);
  console.log("[frontdesk webhook]", active ? "reactivated" : "deactivated", businessKey);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(500).send("Webhook isn't configured yet");

  var rawBody;
  try {
    rawBody = await buffer(req);
  } catch (err) {
    return res.status(400).send("Could not read request body");
  }

  var event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[frontdesk webhook] signature verification failed:", err.message);
    return res.status(400).send("Webhook signature verification failed");
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object);
    } else if (event.type === "customer.subscription.deleted") {
      await setActiveFlag(event.data.object, false);
    } else if (event.type === "customer.subscription.updated") {
      var sub = event.data.object;
      var inactiveStatuses = ["canceled", "unpaid", "incomplete_expired"];
      await setActiveFlag(sub, inactiveStatuses.indexOf(sub.status) === -1);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[frontdesk webhook] handler error for event", event.type, ":", err.message);
    // Non-2xx so Stripe retries later (e.g. a transient GitHub API error, or
    // a stale-sha conflict on a near-simultaneous update) - safe to retry
    // given the idempotency checks above.
    return res.status(500).json({ error: "Internal error" });
  }
};

module.exports.config = { api: { bodyParser: false } };
