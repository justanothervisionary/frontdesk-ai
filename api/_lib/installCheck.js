// Shared by api/dashboard.js's on-demand "Check my installation" button and
// api/weekly-digest.js's passive weekly check - one implementation so the
// two can never drift apart on what "installed" actually means.
//
// Returns true/false/null - null means "couldn't confirm either way" (no
// domain on file, SSRF-guard rejection, fetch failure, or timeout), never a
// false negative dressed up as a definite "not installed". A lenient match
// (tolerant of quote style/whitespace) so a correctly-installed widget
// never false-negatives either - a wrong "it's broken" reading directly
// undermines the trust this whole check exists to protect. Can't detect a
// tag-manager-injected install either way (never present in server-
// rendered HTML) - callers should frame a non-match as "couldn't confirm",
// not a flat negative.
const { assertSafeToFetch } = require("./ssrfGuard");

function isWidgetInstalled(html, businessKey) {
  var re = new RegExp("data-business\\s*=\\s*['\"]\\s*" + businessKey + "\\s*['\"]", "i");
  return re.test(html);
}

async function checkInstallation(domain, businessKey, timeoutMs) {
  if (!domain) return null;
  var urlString = "https://" + domain;

  try {
    await assertSafeToFetch(urlString);
  } catch (err) {
    return null;
  }

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, timeoutMs || 4000);
  try {
    var res = await fetch(urlString, { signal: controller.signal, redirect: "follow" });
    var html = await res.text();
    return isWidgetInstalled(html, businessKey);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { checkInstallation };
