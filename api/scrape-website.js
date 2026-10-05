// Vercel serverless function - two onboarding shortcuts that both end up
// doing the same job: turn a pile of raw text into a short factual
// reference plus a few auto-filled form fields.
// - "read my website": fetches a business's own site server-side (never
//   from the browser - their site almost certainly has no CORS header
//   allowing that anyway) and strips it down to plain text.
// - PDF upload: the browser already extracted the PDF's text (pdf.js) and
//   sends it straight here as `text` - no fetch involved, so the SSRF
//   checks below simply don't apply to that path.
// Either way the raw text is handed to Claude via a forced tool call (not
// asking it to emit JSON as plain text - that's fragile to markdown fences,
// truncation, or a conversational preamble; tool-calling parses cleanly
// every time). The result - a factual summary plus whichever of
// businessName/phone/type Claude was actually confident about - drops into
// shared/onboarding-scan.js's applyScanResult() on the frontend for the
// visitor to review/edit. This never writes anything on its own.
//
// Fetching a visitor-supplied URL server-side is a classic SSRF vector, so
// every request's hostname is resolved and checked against private/
// reserved IP ranges first (api/_lib/ssrfGuard.js) - a public-looking
// domain can still resolve to an internal address. Raw `text` requests
// never touch fetch() at all, so no SSRF surface there.
const Anthropic = require("@anthropic-ai/sdk");
const { createRateLimiter } = require("./_lib/rateLimit");
const { assertSafeToFetch } = require("./_lib/ssrfGuard");
const { isKnownType, isPhoneShaped } = require("./_lib/config");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const isRateLimited = createRateLimiter(5, 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_HTML_CHARS = 300000; // ~300KB of markup - plenty for a small business homepage, bounds worst-case processing
const FETCH_TIMEOUT_MS = 8000;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "$& ") // keep block boundaries from running words together
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(url) {
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrontdeskBot/1.0; +https://www.frontdesksuite.co.uk)" }
    });
    if (!res.ok) throw new Error("Site responded with " + res.status);
    var html = (await res.text()).slice(0, MAX_HTML_CHARS);
    return htmlToText(html);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests - please try again in a minute." });
  }

  var body = req.body || {};
  var rawText = (body.text || "").toString().trim();
  var pageText;

  if (rawText) {
    // PDF-upload path - the text was already extracted client-side, so
    // there's no URL to fetch or validate at all.
    pageText = rawText;
  } else {
    var rawUrl = (body.url || "").toString().trim().slice(0, 500);
    if (!rawUrl) return res.status(400).json({ error: "No URL or text provided" });
    if (!/^https?:\/\//i.test(rawUrl)) rawUrl = "https://" + rawUrl;

    try {
      await assertSafeToFetch(rawUrl);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      pageText = await fetchPageText(rawUrl);
    } catch (err) {
      console.error("[frontdesk scrape-website] fetch failed:", err.message);
      return res.status(502).json({ error: "Couldn't load that site - check the address and try again." });
    }
  }

  if (!pageText || pageText.length < 40) {
    return res.status(422).json({ error: "Couldn't find enough text there - try pasting the info manually instead." });
  }

  try {
    var completion = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: "You turn raw text about a small local business - scraped from their website, or extracted from a PDF they uploaded (a menu, brochure, service list, etc.) - into a short, factual reference a customer-service AI will use to answer visitor questions, plus a few structured details for an onboarding form. Only use real facts actually present in the text - never invent or assume anything not stated. Leave businessName/phone/type empty if you're not genuinely confident, rather than guessing - these pre-fill form fields a human will review, so a wrong guess is worse than a blank.",
      messages: [{ role: "user", content: "Business text:\n\n" + pageText.slice(0, 12000) }],
      tool_choice: { type: "tool", name: "extract_business_profile" },
      tools: [{
        name: "extract_business_profile",
        description: "Record the extracted business profile.",
        input_schema: {
          type: "object",
          properties: {
            hasEnoughInfo: {
              type: "boolean",
              description: "False if the text is mostly navigation, cookie notices, or unrelated content - i.e. there isn't enough real business information here to work with."
            },
            businessName: { type: "string", description: "The business's real name, exactly as stated. Empty string if unclear." },
            phone: { type: "string", description: "Their contact phone number, exactly as written. Empty string if none is given." },
            type: {
              type: "string",
              enum: ["appointments", "callouts", "viewings", "bookings", "classes", "quotes", "retail", "automotive", "general", ""],
              description: "appointments = books appointments (clinics, salons, therapists); callouts = call-outs/jobs (trades, home services); viewings = viewings/valuations (estate agents); bookings = reservations/bookings (restaurants, venues, event spaces); classes = class/session bookings (gyms, studios, tutors); quotes = quotes/consultations (solicitors, accountants, consultants, other professional services); retail = shop/product enquiries (retail, online stores); automotive = vehicle servicing/sales (garages, dealerships); general = general enquiries; \"\" if genuinely unclear."
            },
            summary: {
              type: "string",
              description: "Plain descriptive sentences (not a list or navigation menu) covering services offered, hours, location, pricing, policies, specialties - whatever's actually present. Under 900 characters."
            }
          },
          required: ["hasEnoughInfo", "summary"]
        }
      }]
    });

    var toolUse = completion.content && completion.content.find(function (block) { return block.type === "tool_use"; });
    var result = toolUse ? toolUse.input : null;

    if (!result || result.hasEnoughInfo === false || !result.summary || !result.summary.trim()) {
      return res.status(422).json({ error: "Couldn't find enough business detail there - try pasting the info manually instead." });
    }

    // Re-validated server-side regardless of what the model returned - this
    // is about to pre-fill form fields, not just display text, so the same
    // defense-in-depth as everywhere else in this codebase applies. `type`
    // is simply omitted (never defaulted to "general") when it doesn't
    // match - that default belongs to the dropdown itself, not this endpoint.
    var response = { text: result.summary.toString().trim().slice(0, 1000) };
    var businessName = (result.businessName || "").toString().trim().slice(0, 80);
    if (businessName) response.businessName = businessName;
    var phone = (result.phone || "").toString().trim().slice(0, 40);
    if (isPhoneShaped(phone)) response.phone = phone;
    if (isKnownType(result.type)) response.type = result.type;

    return res.status(200).json(response);
  } catch (err) {
    console.error("[frontdesk scrape-website] AI summarization failed:", err.message);
    return res.status(502).json({ error: "Something went wrong reading that - please try again." });
  }
};
