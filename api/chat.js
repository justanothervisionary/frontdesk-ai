// Vercel serverless function - server-side only, never bundled to the client.
// The API key lives in process.env.ANTHROPIC_API_KEY (Vercel env var), and is
// never returned to, or reachable from, the browser.
const Anthropic = require("@anthropic-ai/sdk");
const { loadConfig, sanitizePreviewConfig } = require("./_lib/config");
const { createRateLimiter } = require("./_lib/rateLimit");
const { applyWidgetCors, isOriginAllowed } = require("./_lib/cors");
const { recordUsage } = require("./_lib/usage");
const { recordMissedQuestion } = require("./_lib/missedQuestions");
const { sendNotification } = require("./_lib/leadNotify");
const { appendLead } = require("./_lib/leadLog");
const { buildSystemPrompt, buildCaptureLeadTool, FLAG_UNANSWERED_TOOL } = require("./_lib/aiPrompt");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Demo-stage safety net: true per-IP persistent rate limiting needs a shared
// store (Vercel KV / Upstash) since serverless functions don't share memory
// across invocations - that's a "when this has real paying traffic" upgrade,
// noted in SECURITY.md. For now the primary safety net is the hard spending
// cap you set in the Anthropic console (do this before going live) - this
// in-memory counter is a best-effort secondary layer only, not a guarantee.
const isRateLimited = createRateLimiter(20, 60 * 1000);

// A separate, stricter limit specifically on actually capturing a lead
// (sending a real notification email) - matches api/lead.js's own dedicated
// limit for the manual form. Without this, a chat-based path to triggering
// real emails would be reachable at the much looser general chat rate above.
// Each endpoint is its own serverless function with its own in-memory
// counter, so these don't compose into one true combined cap - same
// best-effort caveat as every other rate limiter in this codebase.
const isLeadCaptureRateLimited = createRateLimiter(10, 60 * 1000);

module.exports = async function handler(req, res) {
  applyWidgetCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many messages - please try again in a minute." });
  }

  var body = req.body || {};
  var businessKey = body.businessKey;
  var message = (body.message || "").toString().slice(0, 1000); // hard cap on input length
  var history = Array.isArray(body.history) ? body.history.slice(-6) : []; // last 6 turns only - keeps cost bounded
  var leadAlreadyCaptured = body.leadAlreadyCaptured === true;

  // File-based config (a real, reviewed business) takes priority. Only
  // falls back to the visitor-supplied previewConfig (sanitized above) when
  // there's no matching file - i.e. only for the self-serve tool's ad-hoc
  // "try it with your own business" configs, never able to override a real
  // client's own settings. Kept as its own variable (not just inlined into
  // the fallback below) so usage tracking further down can tell a real,
  // file-backed business apart from an unauthenticated free-preview
  // request - see the recordUsage() call below for why that matters.
  var fileConfig = loadConfig(businessKey);
  var config = fileConfig || sanitizePreviewConfig(body.previewConfig);
  if (!config) return res.status(400).json({ error: "Unknown business" });
  if (!isOriginAllowed(req.headers.origin, config)) {
    return res.status(403).json({ error: "This origin is not authorized for this business." });
  }
  // Deliberately not the 503 path below - that's what tells the widget to
  // fall back to local keyword matching, which would keep a cancelled
  // client's bot quietly answering forever off stale data. This is a
  // defense-in-depth backstop only; in normal operation the widget itself
  // already refuses to even load for an inactive config (see
  // widget/frontdesk-widget.js), so this path should rarely if ever fire.
  if (config.active === false) {
    return res.status(403).json({ error: "This assistant is no longer active.", inactive: true });
  }
  if (!message.trim()) return res.status(400).json({ error: "Empty message" });

  try {
    var requestOptions = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      // Cached: the system prompt is identical for every visitor to the
      // same business within the cache window, so this is the single
      // biggest lever on cost once a business's training text gets long -
      // cache reads run at a 90% discount vs. a fresh input token. Safe to
      // mark cacheable even for a one-off preview config: it still pays off
      // across turns within that same conversation.
      system: [
        { type: "text", text: buildSystemPrompt(config), cache_control: { type: "ephemeral" } }
      ],
      messages: history.concat([{ role: "user", content: message }])
    };

    // Both only ever offered to a real, file-backed business - never the
    // free preview tool (no real config file behind it, so either tool
    // firing there would just be a permanent, unpruned write nothing ever
    // reads back). capture_lead also stops being offered once the widget
    // has told us (via leadAlreadyCaptured) this conversation already got
    // one; flag_unanswered keeps working regardless, since a conversation
    // can hit an FAQ gap at any point, lead captured or not. tool_choice
    // "auto", not forced: most turns won't use either at all. Offering both
    // together under disable_parallel_tool_use means the model can only
    // call ONE per turn - a message that's both unanswerable AND contains
    // contact info might not fire both - made explicit in
    // FLAG_UNANSWERED_TOOL's own description rather than left to chance.
    var tools = [];
    if (fileConfig) {
      if (!leadAlreadyCaptured) tools.push(buildCaptureLeadTool());
      tools.push(FLAG_UNANSWERED_TOOL);
    }
    if (tools.length) {
      requestOptions.tools = tools;
      requestOptions.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }

    var completion = await anthropic.messages.create(requestOptions);

    // Content blocks aren't guaranteed to come back in a fixed order once a
    // tool is involved, so the text reply and any tool call are pulled out
    // independently rather than assuming content[0] is the text (which is
    // only safe when no tool is offered at all).
    var content = completion.content || [];
    var textBlock = content.find(function (b) { return b.type === "text"; });
    var captureToolUse = content.find(function (b) { return b.type === "tool_use" && b.name === "capture_lead"; });
    var flagToolUse = content.find(function (b) { return b.type === "tool_use" && b.name === "flag_unanswered"; });

    var reply;
    if (textBlock && textBlock.text.trim()) {
      reply = textBlock.text.trim();
    } else if (captureToolUse) {
      // Claude sometimes calls the tool without also producing prose -
      // config.fallbackAnswer ("I'll pass that on to the team...") is the
      // couldn't-answer message and would read as a non-sequitur right
      // after a visitor just gave their number. Checked specifically
      // against captureToolUse, not "any tool fired" - a bare
      // flagToolUse with no prose should fall through to fallbackAnswer
      // below instead, never claim contact info was captured when it wasn't.
      reply = "Thanks - I've got that, someone from the team will be in touch.";
    } else {
      reply = config.fallbackAnswer;
    }

    // Fire-and-forget, like recordUsage() below - losing an occasional
    // entry is fine; this must never add latency to the visitor's reply.
    if (fileConfig && flagToolUse) {
      recordMissedQuestion(businessKey, message).catch(function () {});
    }

    // Cheap visibility into whether caching is actually paying off, without
    // a whole analytics pipeline - cache_read_input_tokens > 0 means this
    // request got the 90%-off rate on the system prompt.
    var usage = completion.usage || {};
    if (usage.cache_read_input_tokens || usage.cache_creation_input_tokens) {
      console.log("[frontdesk chat] cache usage:", businessKey, "read:", usage.cache_read_input_tokens || 0, "created:", usage.cache_creation_input_tokens || 0, "fresh:", usage.input_tokens || 0);
    }

    // Fire-and-forget - deliberately NOT awaited. recordUsage() has its own
    // timeout and never throws, but even so, a visitor's actual reply must
    // never wait on this. Only for real, file-backed businesses: the free
    // preview tool has no auth at all, so recording usage for it would let
    // anyone write arbitrary keys into the usage store indefinitely.
    if (fileConfig) recordUsage(businessKey, usage).catch(function () {});

    // Capturing a lead is NOT fire-and-forget like usage tracking - silently
    // losing a real enquiry is exactly the bug this feature exists to fix.
    // But a delivery failure must never turn into a broken response: the
    // visitor still gets the real conversational reply Claude generated
    // either way, never a 502 or a swapped-out message - that would discard
    // a perfectly good answer and trip the widget's degraded local-matching
    // fallback for an unrelated reason. Success/failure goes into
    // leadCaptured instead, same success condition api/lead.js already uses.
    var leadCaptured = false;
    if (captureToolUse && !isLeadCaptureRateLimited(ip)) {
      var capturedContact = ((captureToolUse.input && captureToolUse.input.contact) || "").toString().trim().slice(0, 200);
      var capturedName = ((captureToolUse.input && captureToolUse.input.name) || "").toString().trim().slice(0, 200);
      if (capturedContact) {
        var transcript = history.concat([
          { role: "user", content: message },
          { role: "assistant", content: reply }
        ]).slice(-6);
        var captureResults = await Promise.all([
          sendNotification(config, { name: capturedName || "Website visitor", contact: capturedContact, transcript: transcript }),
          appendLead(businessKey, { name: capturedName || "Website visitor", contact: capturedContact, transcript: transcript }).catch(function (err) {
            console.error("[frontdesk chat] failed to log captured lead for digest:", businessKey, err.message);
          })
        ]);
        var captureResult = captureResults[0];
        leadCaptured = !(captureResult.configured && !captureResult.delivered);
      }
    }

    return res.status(200).json({ reply: reply, leadCaptured: leadCaptured });
  } catch (err) {
    console.error("[frontdesk chat] provider error:", err.message);
    // A non-2xx here (not the generic fallback text with a 200) is
    // deliberate: it's what makes the widget's own .catch() handler kick
    // in and fall back to real local FAQ matching, instead of everyone
    // silently getting the same canned non-answer regardless of what they
    // asked. Found this the hard way testing the live deployment - a 200
    // here reads as "success" to the client, so real answers were being
    // replaced by a generic one even for questions with a perfect FAQ
    // match.
    return res.status(503).json({ error: "AI backend unavailable", degraded: true });
  }
};
