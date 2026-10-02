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
const { escapeHtml } = require("./_lib/leadNotify");

// Where a business's real contact email is stored - deliberately NOT in
// configs/{key}.json, which is served to the public internet as-is. See
// the matching comment in api/_lib/config.js: anything under api/ is never
// served as a static file by Vercel, so this path is unreachable from the
// public internet.
function privateFilePath(businessKey) {
  return "api/_private-configs/" + businessKey + ".json";
}

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://frontdesk-ai-chi-ten.vercel.app";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.LEAD_FROM_ADDRESS || "Frontdesk <leads@YOUR-DOMAIN>";

// A new signup lands on site/success.html right after checkout, which shows
// the install snippet live - but that's a one-time view. Without this, a
// business that closes that tab (or loses the snippet before installing it)
// has no way back to it, and no idea their dashboard - where they can edit
// their greeting/FAQs, see leads, or manage billing - even exists. Best-
// effort and never allowed to fail the webhook itself: this fires after the
// config is already successfully published, so a failed welcome email
// should never turn a genuinely successful signup into a Stripe retry (see
// the try/catch around the call site below).
async function sendWelcomeEmail(notifyEmail, businessKey, businessName) {
  if (!RESEND_API_KEY) {
    console.log("[frontdesk webhook] Resend not configured - welcome email not sent for", businessKey);
    return;
  }

  var snippet =
    "&lt;script src=\"" + SITE_BASE_URL + "/widget/frontdesk-widget.js\"\n" +
    "        data-business=\"" + businessKey + "\"\n" +
    "        data-config-url=\"" + SITE_BASE_URL + "/configs/" + businessKey + ".json\"\n" +
    "        data-api-url=\"" + SITE_BASE_URL + "/api/chat\"\n" +
    "        defer&gt;&lt;/script&gt;";
  var loginUrl = SITE_BASE_URL + "/site/login.html";

  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: notifyEmail,
      subject: "Welcome to Frontdesk - " + businessName + " is live",
      html:
        "<p>Your AI receptionist for " + escapeHtml(businessName) + " is live and ready to install.</p>" +
        "<p>If you've already pasted the install snippet into your site, you're all set. If you lost it or haven't yet, here it is again:</p>" +
        "<pre style=\"background:#14161a;color:#f3f4f6;padding:14px 16px;border-radius:10px;font-size:12px;overflow-x:auto;\">" + snippet + "</pre>" +
        "<p>Whenever you need to update your greeting or FAQs, check your leads, or manage billing, log in to your dashboard - no password needed, just click the link and we'll email you a one-time login link:</p>" +
        "<p><a href=\"" + loginUrl + "\">" + loginUrl + "</a></p>"
    })
  });

  if (!res.ok) {
    console.error("[frontdesk webhook] welcome email failed:", res.status, await res.text().catch(function () { return ""; }));
  }
}

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

  var notifyEmail = (session.customer_details && session.customer_details.email) || config.notifyEmail;
  delete config.notifyEmail; // never written to the public config file - see privateFilePath()
  config.active = true;
  config.stripeCustomerId = session.customer;
  config.stripeSubscriptionId = session.subscription;
  config.stripeCheckoutSessionId = session.id;

  await putFile(filePath, config, "Publish config for " + businessKey + " (auto-published via Stripe trial signup)");
  if (notifyEmail) {
    await putFile(privateFilePath(businessKey), { notifyEmail: notifyEmail }, "Set contact email for " + businessKey);
  }
  console.log("[frontdesk webhook] published new config for", businessKey);

  // Caught locally, deliberately - the config is already successfully
  // published at this point, so a welcome-email failure must never throw
  // back out to the handler's own try/catch, which would return a 500 and
  // make Stripe retry the whole event. On that retry, the idempotency check
  // at the top of this function (existingConfig.stripeCheckoutSessionId ===
  // session.id) would see the config already exists and return early before
  // ever reaching this point again - so the email would never get a second
  // chance to send if its failure were allowed to trigger a retry.
  if (notifyEmail) {
    try {
      await sendWelcomeEmail(notifyEmail, businessKey, config.businessName);
    } catch (err) {
      console.error("[frontdesk webhook] welcome email threw:", businessKey, err.message);
    }
  }
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
