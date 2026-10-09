// Shared between api/lead.js (upload + the manual "leave your details"
// form) and api/chat.js (the AI's own capture_lead tool) - both paths can
// end up emailing a business a lead that includes visitor-attached files,
// so both validate the attachment list the exact same way rather than two
// copies that could drift.
const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf"
};

const MAX_BYTES = 6 * 1024 * 1024; // 6MB - generous for a phone photo, bounded enough to keep Blob costs/abuse in check
const MAX_ATTACHMENTS_PER_LEAD = 3;

// Vercel Blob's own public URL shape. Not just a style preference - the
// `attachments` array arrives in a normal JSON body that any caller could
// hand-craft directly to this API, bypassing the widget entirely. Without
// this check, that's a free way to get an arbitrary link (a phishing page,
// say) emailed to a business from an address they trust. Failing the
// pattern just means "that attachment is silently dropped", never "trust
// it anyway" - a false negative here costs nothing but a missing link, a
// false positive would be a real spoofing hole.
const BLOB_URL_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/.+$/i;

// Used by the upload endpoint itself to decide what it's willing to store.
function isAllowedContentType(contentType) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, contentType);
}

function extensionFor(contentType) {
  return ALLOWED_TYPES[contentType];
}

// Used when a lead is about to be captured (chat.js/lead.js) - trims an
// attacker-controlled array down to something safe to store and email:
// right shape, our own domain only, capped count/length.
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < MAX_ATTACHMENTS_PER_LEAD; i++) {
    var item = list[i];
    if (!item || typeof item !== "object") continue;
    var url = (item.url || "").toString().slice(0, 500);
    if (!BLOB_URL_RE.test(url)) continue;
    var name = (item.name || "attachment").toString().trim().slice(0, 150) || "attachment";
    out.push({ url: url, name: name });
  }
  return out;
}

// Used by the smart-quoting path (api/chat.js) to decide which of a
// sanitized attachment's {url, name} is actually vision-eligible - PDFs
// pass the same upload allowlist but aren't an image. The sanitized
// shape carries no content-type, only the URL, which does carry the
// original extension (blob paths are built via extensionFor() above).
var IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp)$/i;
function isImageAttachment(attachment) {
  return !!(attachment && IMAGE_EXTENSION_RE.test((attachment.url || "")));
}

var IMAGE_MEDIA_TYPE_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

// Turns an already-validated, vision-eligible attachment into an
// Anthropic image content block. The installed SDK's stable Messages
// API only accepts base64 image sources (confirmed directly against
// its type definitions - there is no url-source variant), so this
// fetches the Blob URL's bytes server-side and inlines them, rather
// than passing the URL straight through as originally assumed. Never
// throws - returns null on any failure (timeout, fetch error, oversized,
// unrecognized extension), which callers should treat as "skip this
// image" rather than fatal.
async function fetchImageContentBlock(attachment, timeoutMs) {
  var ext = (attachment.url.match(/\.([a-z0-9]+)$/i) || [])[1];
  var mediaType = IMAGE_MEDIA_TYPE_BY_EXT[(ext || "").toLowerCase()];
  if (!mediaType) return null;
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 4000);
  try {
    var res = await fetch(attachment.url, { signal: controller.signal });
    if (!res.ok) return null;
    var buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    return { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } };
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ALLOWED_TYPES, MAX_BYTES, MAX_ATTACHMENTS_PER_LEAD, isAllowedContentType, extensionFor, sanitizeAttachments, isImageAttachment, fetchImageContentBlock };
