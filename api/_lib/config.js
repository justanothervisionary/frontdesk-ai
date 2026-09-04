// Shared by api/chat.js and api/lead.js (previously copy-pasted in both).
const fs = require("fs");
const path = require("path");
const { buildFrontdeskConfig, GREETINGS } = require("../../shared/build-config");
const avatarPresets = require("../../shared/avatar-presets");

// The same 4 "what do you do?" options the onboarding dropdown offers -
// reused here (rather than a second hardcoded list) so this can never drift
// from shared/build-config.js. See api/chat.js's CONVERSION_GOALS for how
// this steers the core system prompt's conversion guidance.
var KNOWN_TYPES = Object.keys(GREETINGS);
function isKnownType(v) {
  return KNOWN_TYPES.indexOf(v) !== -1;
}

// businessKey is validated against a strict allowlist pattern before ever
// touching the filesystem, so this can't be used to read arbitrary paths.
//
// notifyEmail lives in a SEPARATE file under api/_private-configs/ rather
// than in the main configs/{key}.json - that main file is served to the
// public internet as-is (the widget fetches it directly from the browser),
// so anything in it is effectively public. A business's real contact email
// has no reason to be in that file at all. It's merged in here from disk,
// server-side only (api/chat.js and api/lead.js, never the browser).
// Anything under api/ is never served as a static file by Vercel - only
// reachable via an actual function invocation - so this is genuinely
// unreachable from the public internet, unlike configs/ itself.
function loadConfig(businessKey) {
  if (!/^[a-z0-9-]+$/.test(businessKey || "")) return null;
  const configPath = path.join(__dirname, "..", "..", "configs", `${businessKey}.json`);
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const privatePath = path.join(__dirname, "..", "_private-configs", `${businessKey}.json`);
  if (fs.existsSync(privatePath)) {
    const priv = JSON.parse(fs.readFileSync(privatePath, "utf8"));
    if (priv.notifyEmail) config.notifyEmail = priv.notifyEmail;
  }
  return config;
}

// The "Make Your AI Receptionist" self-serve tool builds a config live from
// whatever a stranger types in, with no file behind it - this validates and
// hard-caps that input before it's ever allowed near a prompt. Never trust
// size or shape of anything from here; this is the free-preview path that
// isn't reviewed by us first.
function sanitizePreviewConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  var businessName = (raw.businessName || "").toString().slice(0, 80);
  if (!businessName.trim()) return null;

  var faqs = Array.isArray(raw.faqs) ? raw.faqs.slice(0, 8) : [];
  faqs = faqs.map(function (f) {
    // 1000, not 300 - the "teach it something about your business" box now
    // allows up to 1000 characters (see shared/build-config.js), and that
    // text travels through here as an FAQ entry - this cap must not
    // silently truncate it back down.
    return { answer: ((f && f.answer) || "").toString().slice(0, 1000) };
  }).filter(function (f) { return f.answer.trim(); });

  return {
    businessName: businessName,
    type: isKnownType(raw.type) ? raw.type : "general",
    faqs: faqs,
    fallbackAnswer: ((raw.fallbackAnswer || "").toString().slice(0, 300)) ||
      "I'll pass that on to the team and someone will get back to you shortly."
  };
}

function isHexColor(v) {
  return typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}

function isEmailShaped(v) {
  return typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && v.length <= 200;
}

// A bare hostname, e.g. "dentistw4.co.uk" - no protocol, no path. This is
// what api/_lib/cors.js checks an incoming request's Origin header against,
// so it controls which website(s) this business's widget will actually
// work on once installed.
function isDomain(v) {
  return typeof v === "string" && v.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v);
}

var KNOWN_AVATAR_URLS = avatarPresets.PRESETS.map(function (p) { return avatarPresets.svgToDataUri(p.svg); });

// An uploaded-avatar URL is only ever trusted if it matches our own
// upload path with a properly-formed generated filename - never an
// arbitrary caller-supplied URL, which would otherwise let a config point
// the widget at attacker-controlled content.
var UPLOADED_AVATAR_RE = /^https:\/\/[^\/\s]+\/configs\/avatars\/[0-9a-f]{24}\.(png|jpg|webp|gif)$/i;

function isKnownAvatarUrl(url) {
  return KNOWN_AVATAR_URLS.indexOf(url) !== -1 || UPLOADED_AVATAR_RE.test(url || "");
}

// Stricter sanitizer for anything about to become a REAL, permanent,
// committed client config (as opposed to sanitizePreviewConfig's disposable
// in-memory preview). Extends the same capping/hardening rather than
// reinventing it - a paying customer's own typed input is still not
// something to trust blindly (defense in depth): validates the accent
// color is an actual hex value, only accepts an avatar URL that matches one
// of our own known presets (never an arbitrary attacker-controlled string
// or URL), and caps every field the same way the preview sanitizer does.
function sanitizeCommittedConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  var businessName = (raw.businessName || "").toString().slice(0, 80).trim();
  if (!businessName) return null;

  var theme = raw.theme || {};
  var accentColor = isHexColor(theme.accentColor) ? theme.accentColor : "#2f8fe0";
  var assistantName = ((theme.assistantName || "Ivy").toString().slice(0, 40).trim()) || "Ivy";
  var avatarUrl = isKnownAvatarUrl(theme.avatarUrl) ? theme.avatarUrl : undefined;

  var faqs = Array.isArray(raw.faqs) ? raw.faqs.slice(0, 8) : [];
  faqs = faqs.map(function (f) {
    return {
      keywords: Array.isArray(f && f.keywords) ? f.keywords.slice(0, 10).map(function (k) { return String(k).slice(0, 30); }) : [],
      // 1000, not 300 - see the matching comment in sanitizePreviewConfig above.
      answer: ((f && f.answer) || "").toString().slice(0, 1000)
    };
  }).filter(function (f) { return f.answer.trim(); });

  return {
    businessName: businessName,
    domain: isDomain(raw.domain) ? raw.domain.toLowerCase() : undefined,
    type: isKnownType(raw.type) ? raw.type : "general",
    theme: { accentColor: accentColor, position: "right", assistantName: assistantName, avatarUrl: avatarUrl },
    greeting: ((raw.greeting || "").toString().slice(0, 300)) || ("Hi! Welcome to " + businessName + "."),
    fallbackAnswer: ((raw.fallbackAnswer || "").toString().slice(0, 300)) ||
      "I'll pass that on to the team and someone will get back to you shortly.",
    faqs: faqs,
    notifyEmail: isEmailShaped(raw.notifyEmail) ? raw.notifyEmail : undefined,
    active: raw.active !== false
  };
}

// Turns a Stripe Checkout Session's draft metadata (businessName, agentName,
// type, phone, color, extraInfo, avatarPresetId) into a real, sanitized
// config - the exact same shape-building logic the free preview uses
// (shared/build-config.js), then run through the stricter committed-config
// sanitizer since this one is about to be written to disk and answer real
// customers, not just render in one visitor's own browser tab.
//
// Checked here, before buildFrontdeskConfig(): that function defaults a
// missing businessName to "Your Business" for the free preview's UX, which
// would otherwise mask a malformed/incomplete webhook event (e.g. missing
// metadata) into silently publishing a bogus config instead of failing
// loudly.
function buildConfigFromDraft(draft) {
  if (!draft || !(draft.businessName || "").toString().trim()) return null;
  var built = buildFrontdeskConfig(draft);
  return sanitizeCommittedConfig(built);
}

module.exports = { loadConfig, sanitizePreviewConfig, sanitizeCommittedConfig, buildConfigFromDraft };
