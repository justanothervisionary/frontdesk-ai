// Google Calendar booking integration - OAuth token exchange/refresh,
// turning a business's config.hours into real bookable slots against
// their actual calendar, and creating the event once a visitor confirms
// one. Hand-rolled REST (fetch + manual headers), no googleapis SDK -
// consistent with every other external integration in this codebase
// (api/_lib/github.js, api/_lib/leadNotify.js, api/whatsapp.js all do
// the same), and avoids that package's large generated client bloating
// the Vercel function bundle for what's a handful of simple REST calls.
//
// Everything here returns null/false on failure rather than throwing,
// EXCEPT createEvent (the one call a caller must know definitely failed,
// since it's about to tell the visitor they're booked) - this mirrors
// api/_lib/whatsappHistory.js's "never throws on the read path, fails
// closed" discipline.
const { pipeline, isConfigured } = require("./upstash");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SLOT_DURATION_MINUTES = 60; // fixed v1 default - no per-business setting yet
const LOOKAHEAD_DAYS = 7;
const MAX_SLOTS_OFFERED = 8;
const FETCH_TIMEOUT_MS = 2500; // per individual Google call - chat.js/whatsapp.js wrap the whole orchestration in their own outer budget on top of this
const AVAILABILITY_CACHE_TTL_SECONDS = 180; // short enough a just-taken slot rarely gets re-offered, long enough to spare repeat Calendar calls within one conversation
const BOOKING_LOCK_TTL_SECONDS = 30;
const HOURS_DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function fetchWithTimeout(url, options) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

// --- Credential storage (Upstash, NOT git) ---
//
// A refresh token can never be committed via the GitHub Contents API -
// confirmed in production, GitHub's push protection rejects the write
// outright ("Secret detected in content", tagged GOOGLE_OAUTH_REFRESH_
// TOKEN) on every single attempt, not just occasionally. Even without
// that hard block, a long-lived secret like this has no business sitting
// in permanent, unrevocable git history. Stored here instead, with no
// TTL - this persists until disconnectGoogleCalendar's delete clears it,
// unlike every other Upstash key in this codebase (which are all
// deliberately short-lived caches/locks).

function authKey(businessKey) { return "calendar-auth:" + businessKey; }

async function saveGoogleCalendarAuth(businessKey, refreshToken, calendarId) {
  if (!isConfigured()) throw new Error("Upstash not configured - cannot store calendar credentials");
  await pipeline([["SET", authKey(businessKey), JSON.stringify({ refreshToken: refreshToken, calendarId: calendarId })]]);
}

// Never throws - same "read side degrades to null, never breaks the
// caller" contract as getCachedAvailability below.
async function getGoogleCalendarAuth(businessKey) {
  if (!isConfigured()) return null;
  try {
    var result = await pipeline([["GET", authKey(businessKey)]]);
    var raw = result[0] && result[0].result;
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

async function deleteGoogleCalendarAuth(businessKey) {
  if (!isConfigured()) return;
  try {
    await pipeline([["DEL", authKey(businessKey)]]);
  } catch (err) { /* best-effort - worst case a stale credential sits unused, harmless */ }
}

// --- OAuth ---

async function exchangeAuthCode(code, redirectUri) {
  var res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    }).toString()
  });
  if (!res.ok) throw new Error("Google token exchange failed (" + res.status + "): " + await res.text().catch(function () { return ""; }));
  var data = await res.json();
  return { refreshToken: data.refresh_token || null, accessToken: data.access_token, expiresIn: data.expires_in };
}

// Returns { accessToken, expiresIn } on success, { revoked: true } if the
// business revoked access from their own Google account (the one case
// callers must react to differently - the calendar needs reconnecting,
// not just "try again later"), or null on any transient failure. Never
// throws.
async function refreshAccessToken(refreshToken) {
  var res;
  try {
    res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token"
      }).toString()
    });
  } catch (err) {
    return null;
  }
  if (!res.ok) {
    var bodyText = await res.text().catch(function () { return ""; });
    if (bodyText.indexOf("invalid_grant") !== -1) return { revoked: true };
    console.error("[frontdesk googleCalendar] token refresh failed (" + res.status + "):", bodyText);
    return null;
  }
  var data = await res.json();
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

// --- UK time (every target business is UK-based - hardcoded, not
// inferred). The widget's own client-side isOpenNow() gets away with
// "use the visitor's local clock"; a serverless function has no such
// notion, and Google's freeBusy API needs unambiguous UTC instants, so
// this is load-bearing, not an assumption. One correction pass is exact
// here since UK clock changes land at 1am local, nowhere near any real
// business-hours window. ---

function londonOffsetMinutes(utcInstant) {
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  var parts = dtf.formatToParts(utcInstant).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
  var asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asIfUtc - utcInstant.getTime()) / 60000; // +60 during BST, 0 during GMT
}

function londonWallTimeToUtcIso(dateStr, timeStr) {
  var naive = new Date(dateStr + "T" + timeStr + ":00Z");
  var offset = londonOffsetMinutes(naive);
  return new Date(naive.getTime() - offset * 60000).toISOString();
}

function londonDateStr(utcInstant) {
  // en-CA formats as YYYY-MM-DD, exactly what we need for re-feeding into
  // londonWallTimeToUtcIso.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(utcInstant);
}

function slotLabel(utcInstant) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true
  }).format(utcInstant);
}

// --- Pure slot math (no network) ---

// config.hours -> a grid of candidate {startIso, endIso, label} slots
// over the next `lookaheadDays`, honoring each day's open/close window
// and skipping anything already closer than 30 minutes away. Pure and
// cheap - safe to call repeatedly (isKnownOfferedSlot re-derives this
// fresh rather than trusting a possibly-stale cache entry).
function computeCandidateSlots(hours, lookaheadDays, durationMinutes) {
  if (!hours) return [];
  var days = lookaheadDays || LOOKAHEAD_DAYS;
  var duration = durationMinutes || SLOT_DURATION_MINUTES;
  var now = Date.now();
  var slots = [];
  for (var i = 0; i < days; i++) {
    var dayInstant = new Date(now + i * 86400000);
    var dateStr = londonDateStr(dayInstant);
    var dayKey = HOURS_DAY_KEYS[new Date(dateStr + "T12:00:00Z").getUTCDay()];
    var range = hours[dayKey];
    if (!range) continue;

    var dayStart = new Date(londonWallTimeToUtcIso(dateStr, range[0]));
    var dayEnd = new Date(londonWallTimeToUtcIso(dateStr, range[1]));
    var cursor = dayStart.getTime();
    while (cursor + duration * 60000 <= dayEnd.getTime()) {
      if (cursor > now + 30 * 60000) {
        var startDate = new Date(cursor);
        slots.push({
          startIso: startDate.toISOString(),
          endIso: new Date(cursor + duration * 60000).toISOString(),
          label: slotLabel(startDate)
        });
      }
      cursor += duration * 60000;
    }
  }
  return slots;
}

// Re-derives the candidate grid fresh rather than trusting a cache entry
// still being alive - this is what actually validates the model's
// book_appointment call, independent of AVAILABILITY_CACHE_TTL_SECONDS.
function isKnownOfferedSlot(hours, startIso) {
  if (!startIso || !hours) return false;
  var target = new Date(startIso).getTime();
  if (isNaN(target) || target < Date.now()) return false;
  return computeCandidateSlots(hours, LOOKAHEAD_DAYS, SLOT_DURATION_MINUTES)
    .some(function (s) { return s.startIso === startIso; });
}

// --- Network ---

async function getBusyRanges(accessToken, calendarId, timeMinIso, timeMaxIso) {
  var res = await fetchWithTimeout(CALENDAR_API + "/freeBusy", {
    method: "POST",
    headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] })
  });
  if (!res.ok) throw new Error("Google freeBusy failed (" + res.status + "): " + await res.text().catch(function () { return ""; }));
  var data = await res.json();
  var cal = data.calendars && data.calendars[calendarId];
  var busy = (cal && cal.busy) || [];
  return busy.map(function (b) { return { startIso: b.start, endIso: b.end }; });
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function subtractBusy(candidateSlots, busyRanges) {
  if (!busyRanges.length) return candidateSlots;
  return candidateSlots.filter(function (slot) {
    var sStart = new Date(slot.startIso).getTime();
    var sEnd = new Date(slot.endIso).getTime();
    return !busyRanges.some(function (b) {
      return rangesOverlap(sStart, sEnd, new Date(b.startIso).getTime(), new Date(b.endIso).getTime());
    });
  });
}

function availabilityCacheKey(businessKey) { return "calendar-avail:" + businessKey; }

async function getCachedAvailability(businessKey) {
  if (!isConfigured()) return null;
  try {
    var result = await pipeline([["GET", availabilityCacheKey(businessKey)]]);
    var raw = result[0] && result[0].result;
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

async function setCachedAvailability(businessKey, availability) {
  if (!isConfigured()) return;
  try {
    await pipeline([["SET", availabilityCacheKey(businessKey), JSON.stringify(availability), "EX", AVAILABILITY_CACHE_TTL_SECONDS]]);
  } catch (err) { /* best-effort - a cache-write failure just means the next turn pays the full lookup cost again */ }
}

// Orchestrates refresh -> candidate grid -> freeBusy -> subtract -> cap,
// with a short Upstash cache in front of the network calls. Returns
// { slots, promptText } (promptText is "" when slots is empty) or null
// on ANY failure (revoked token, timeout, bad/missing hours) - that null
// is exactly the "skip injection, behave like no calendar is connected"
// signal api/chat.js and api/whatsapp.js need. Logs (never throws) on
// the revoked-token case specifically, tagged distinctly so it reads as
// "business needs to reconnect" in logs rather than a generic error.
async function getAvailableSlots(businessKey, refreshToken, calendarId, hours) {
  if (!refreshToken || !calendarId || !hours) return null;

  var cached = await getCachedAvailability(businessKey);
  if (cached) return cached;

  try {
    var candidates = computeCandidateSlots(hours, LOOKAHEAD_DAYS, SLOT_DURATION_MINUTES);
    if (!candidates.length) return null;

    var tokenResult = await refreshAccessToken(refreshToken);
    if (!tokenResult) return null;
    if (tokenResult.revoked) {
      console.error("[frontdesk googleCalendar] refresh token revoked for", businessKey, "- business needs to reconnect");
      return null;
    }

    var busy = await getBusyRanges(tokenResult.accessToken, calendarId, candidates[0].startIso, candidates[candidates.length - 1].endIso);
    var free = subtractBusy(candidates, busy).slice(0, MAX_SLOTS_OFFERED);

    var availability = free.length
      ? {
          slots: free,
          promptText: "=== REAL UPCOMING AVAILABILITY (live calendar data - only offer from this list) ===\n" +
            free.map(function (s) { return "- " + s.label + " (book_appointment datetime: " + s.startIso + ")"; }).join("\n")
        }
      : { slots: [], promptText: "" };

    await setCachedAvailability(businessKey, availability);
    return availability;
  } catch (err) {
    console.error("[frontdesk googleCalendar] getAvailableSlots failed:", businessKey, err.message);
    return null;
  }
}

// Independent fresh token refresh (deliberately not reusing one from an
// earlier step in the same request) + a narrow freeBusy query for just
// this one window - the real check immediately before writing the
// event. Fails closed: returns false on any uncertainty, never claims a
// slot is free when it isn't sure.
async function isSlotStillFree(refreshToken, calendarId, startIso, endIso) {
  try {
    var tokenResult = await refreshAccessToken(refreshToken);
    if (!tokenResult || tokenResult.revoked) return false;
    var busy = await getBusyRanges(tokenResult.accessToken, calendarId, startIso, endIso);
    return busy.length === 0;
  } catch (err) {
    return false;
  }
}

// A cheap mutex layered on top of isSlotStillFree's own re-check - closes
// the narrow gap between "freeBusy said free" and "event actually
// inserted" when two visitors confirm the same slot within seconds of
// each other. Same SET-NX-EX idiom api/_lib/whatsappHistory.js's
// claimMessageId already establishes. Fails closed (Upstash not
// configured/unreachable -> treat as NOT claimed, so callers skip
// booking rather than risk a double-write) - same reasoning
// claimMessageId's own comment gives for its identical choice.
async function claimBookingSlot(businessKey, startIso) {
  if (!isConfigured()) return false;
  try {
    var result = await pipeline([["SET", "booking-lock:" + businessKey + ":" + startIso, "1", "NX", "EX", BOOKING_LOCK_TTL_SECONDS]]);
    return !!(result[0] && result[0].result);
  } catch (err) {
    return false;
  }
}

async function createEvent(refreshToken, calendarId, opts) {
  var tokenResult = await refreshAccessToken(refreshToken);
  if (!tokenResult || tokenResult.revoked) throw new Error("Google Calendar access is no longer valid - needs reconnecting");
  var res = await fetchWithTimeout(CALENDAR_API + "/calendars/" + encodeURIComponent(calendarId) + "/events", {
    method: "POST",
    headers: { "Authorization": "Bearer " + tokenResult.accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.startIso, timeZone: "Europe/London" },
      end: { dateTime: opts.endIso, timeZone: "Europe/London" }
    })
  });
  if (!res.ok) throw new Error("Google event creation failed (" + res.status + "): " + await res.text().catch(function () { return ""; }));
  var data = await res.json();
  return { eventId: data.id, htmlLink: data.htmlLink };
}

module.exports = {
  exchangeAuthCode, refreshAccessToken, getAvailableSlots, isSlotStillFree, claimBookingSlot, createEvent,
  isKnownOfferedSlot, computeCandidateSlots, SLOT_DURATION_MINUTES,
  saveGoogleCalendarAuth, getGoogleCalendarAuth, deleteGoogleCalendarAuth
};
