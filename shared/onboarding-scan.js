/**
 * Applies a successful api/scrape-website.js response (the "read my
 * website" / PDF-upload result) to whichever onboarding form is using it.
 * Lives here, not inline, because site/index.html and site/signup.html each
 * had their own copy of this fill logic before this existed - one shared
 * helper is what keeps the two from drifting apart as this gets richer than
 * "just drop the text in a textarea".
 *
 * Only ever fills a field the scan actually returned a value for - an
 * unconfident "type" guess (api/scrape-website.js omits the field entirely
 * rather than guessing) must never blank out the dropdown's existing
 * selection, and a field the visitor already filled in by hand is simply
 * overwritten, same as re-running the scan has always overwritten the
 * extraInfo textarea.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FrontdeskOnboardingScan = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ids: { name, type, phone, extraInfo } - each an element id string (no
  // leading #), any of which may be omitted if that page doesn't have it.
  function applyScanResult(data, ids) {
    data = data || {};
    ids = ids || {};

    if (data.businessName && ids.name) {
      var nameEl = document.getElementById(ids.name);
      if (nameEl) nameEl.value = data.businessName;
    }
    if (data.type && ids.type) {
      var typeEl = document.getElementById(ids.type);
      // Already validated server-side against the real known-types list -
      // trusted to be one of the dropdown's own option values.
      if (typeEl) typeEl.value = data.type;
    }
    if (data.phone && ids.phone) {
      var phoneEl = document.getElementById(ids.phone);
      if (phoneEl) phoneEl.value = data.phone;
    }
    if (ids.extraInfo) {
      var extraEl = document.getElementById(ids.extraInfo);
      if (extraEl) {
        extraEl.value = data.text || "";
        extraEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  return { applyScanResult: applyScanResult };
});
