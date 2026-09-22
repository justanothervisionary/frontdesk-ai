// Vercel serverless function - two onboarding shortcuts that both end up
// doing the same job: turn a pile of raw text into the same short factual
// reference the manual "teach your AI" textarea expects.
// - "read my website": fetches a business's own site server-side (never
//   from the browser - their site almost certainly has no CORS header
//   allowing that anyway) and strips it down to plain text.
// - PDF upload: the browser already extracted the PDF's text (pdf.js) and
//   sends it straight here as `text` - no fetch involved, so the SSRF
//   checks below simply don't apply to that path.
// Either way the raw text is handed to Claude to distill down, and the
// result drops into the same textarea for the visitor to review/edit -
// this never writes anything on its own.
//
// Fetching a visitor-supplied URL server-side is a classic SSRF vector, so
// every request's hostname is resolved and checked against private/
// reserved IP ranges first (api/_lib/ssrfGuard.js) - a public-looking
// domain can still resolve to an internal address. Raw `text` requests
// never touch fetch() at all, so no SSRF surface there.
const Anthropic = require("@anthropic-ai/sdk");
const { createRateLimiter } = require("./_lib/rateLimit");
const { assertSafeToFetch } = require("./_lib/ssrfGuard");

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
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FrontdeskBot/1.0; +https://frontdesk-ai-chi-ten.vercel.app)" }
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
      max_tokens: 400,
      system: "You turn raw text about a small local business - scraped from their website, or extracted from a PDF they uploaded (a menu, brochure, service list, etc.) - into a short, factual reference a customer-service AI will use to answer visitor questions. Only include real facts actually present in the text (services offered, hours, location, pricing, policies, specialties) - never invent or assume anything not stated. Write it as plain descriptive sentences, not a list or navigation menu. If the text doesn't contain enough real business information to work with (e.g. it's mostly navigation, cookie notices, or unrelated content), respond with exactly: NOT_ENOUGH_INFO. Keep the result under 900 characters.",
      messages: [{ role: "user", content: "Business text:\n\n" + pageText.slice(0, 12000) }]
    });

    var summary = completion.content && completion.content[0] && completion.content[0].text
      ? completion.content[0].text.trim()
      : "";

    if (!summary || summary.indexOf("NOT_ENOUGH_INFO") !== -1) {
      return res.status(422).json({ error: "Couldn't find enough business detail there - try pasting the info manually instead." });
    }

    return res.status(200).json({ text: summary.slice(0, 1000) });
  } catch (err) {
    console.error("[frontdesk scrape-website] AI summarization failed:", err.message);
    return res.status(502).json({ error: "Something went wrong reading that - please try again." });
  }
};
