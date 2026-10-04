# Frontdesk - security & data overview

Written to be handed directly to a prospect's IT contact or practice manager
during evaluation. Plain language on purpose.

## What it is

A single `<script>` tag that adds a chat widget to your website. Nothing
else changes on your site - no plugin install, no admin access needed, no
dependency on your CMS or hosting platform.

## How it's isolated

- The widget renders inside a **Shadow DOM** - a browser-native sandbox.
  Your site's CSS cannot affect the widget, and the widget's CSS/JS cannot
  affect your site. No class-name collisions, no layout breakage.
- It does not modify, read, or interact with any other element on your
  page. It only adds itself.
- No inline scripts or styles are injected into *your* document - only
  into its own isolated shadow root - so your site's own Content Security
  Policy is unaffected.

## Data handling

- All visitor-typed text is rendered using `textContent`, never
  `innerHTML` with unescaped input - this closes the standard XSS vector
  for a chat-style widget that displays user-typed text.
- The widget can run in two modes: local keyword-matching only (nothing
  ever leaves the browser), or backed by a real AI model via our own
  server-side endpoint. The demo for West London Dental Centres uses the
  live AI mode. In that mode, only the current message plus the last few
  turns of conversation are sent to our backend, over HTTPS - never your
  browsing activity, never anything outside the chat itself.
- The AI provider (Anthropic) only ever sees what the visitor typed plus
  the practice's own public FAQ information - never anything else on your
  site, and the API key that authorizes those calls lives only in a
  server-side environment variable, never in the widget code a visitor's
  browser can see.
- No cookies, no localStorage, no visitor tracking, no third-party
  analytics or ad scripts of any kind - in the embeddable widget itself.
  The separate client dashboard (`site/dashboard.html`, a business logging
  in to manage their own account) does set one cookie for that purpose -
  see "Client dashboard login" below. A visitor chatting with the widget
  on a client's site is never affected by this; the two run on entirely
  separate pages.
- The widget explicitly avoids soliciting or storing symptom/health
  information - questions that sound medical (pain, emergency, "hurts")
  are redirected to "please call the practice," not answered by the bot.
  This is a deliberate scope boundary, not an oversight: a booking/FAQ
  assistant should not be doing anything that resembles triage or medical
  advice.

## Lead capture

A visitor's contact details only ever reach a business if the visitor
chooses to give them - always opt-in, never scraped or inferred. That
happens one of two ways: clicking "leave your details" and filling in the
form directly, or giving a phone number or email in the chat itself after
the AI asks (it's instructed to ask at most once, low-pressure, and only
after it's already been genuinely helpful - never before, never repeated).
Either way, the business only ever learns what the visitor actually chose
to say - the AI can't invent a lead or capture anything a visitor didn't
themselves provide. Both paths trigger the exact same notification,
emailed directly to the business's own configured notification address,
with the last few messages of that conversation included so the business
has context on what the visitor was asking. If email delivery fails for a
live client, the visitor is told honestly to call instead (for the manual
form) or simply keeps the AI's real answer with nothing silently broken
(for the in-chat path) - never a false "success" message that could leave
a real inquiry lost with nobody aware of it.

A lead's name and contact details are also logged to a small per-business
file under `api/_private-configs/leads/{key}.json` - never publicly
reachable, same as the notification address above - purely so
`api/weekly-digest.js` can summarize the last 7 days back to the business
each week, and so the business can review a lead again later from their
own dashboard. Entries older than 35 days are pruned automatically. Each
entry also carries a short excerpt of that conversation (capped at 4
turns) alongside the name/contact - a deliberately tighter cap than the
6 turns used for the one-time notification email, since this write (unlike
that email) rewrites the business's entire accumulated 35-day file on
every new lead.

Separately, when the AI genuinely can't answer a question from the
business's own information, the question text itself (never who asked
it, never tied to a lead) is logged to a small rolling list in Upstash -
the same store already used for usage counts - so the business can see
what's missing from their FAQs. Capped at roughly 150 entries per
business (oldest dropped automatically), not time-based like the lead
log above.

That notification address itself is stored in `api/_private-configs/{key}.json`,
a separate file from the main `configs/{key}.json` the widget fetches
directly from a visitor's browser. Only the server reads the private file
(directly off disk, no HTTP request involved); anything under `api/` is
never served as a static file by Vercel - only reachable via an actual
function invocation - so a business's real contact email is never
reachable over the public internet the way the rest of its config
necessarily is.

## Client dashboard login

A business can log into `site/dashboard.html` to view their leads, edit
their assistant's FAQs/greeting, retrieve their install snippet, and
manage billing. There's no password anywhere in this system - logging in
sends a one-time link to the business's own registered email (magic-link
login), which is what sets a session cookie once clicked.

- The login link is single-use and expires after 15 minutes.
- Clicking it lands on a plain "confirm it's you" page rather than logging
  in immediately on load - this is deliberate: many business email
  providers (Microsoft 365's Safe Links, among others) automatically visit
  every link in an incoming email to scan it before a human ever opens it.
  If the link logged in on that automatic visit, the real click afterward
  would fail. Requiring an actual click closes that gap.
- The session cookie (`__Host-session`) is `HttpOnly` (invisible to
  JavaScript, including any injected via XSS elsewhere), `Secure`
  (HTTPS-only), and `SameSite=Lax`. Every request that changes account
  data (saving an edit, opening billing) additionally checks that it
  genuinely came from our own site before doing anything, independent of
  the cookie - a standard defense-in-depth pairing against cross-site
  request forgery.
- A business can only ever request a login link for an email tied to a
  business that's actually completed a real paid signup. Requesting a
  login link always returns the same generic response either way, so the
  system never confirms or denies whether a given email is a Frontdesk
  customer.
- Editing your own assistant's settings is limited to what a business
  should reasonably self-serve (greeting, fallback answer, FAQs, assistant
  name, notification email) - billing status and subscription identifiers
  are never editable from the dashboard; those are only ever set by
  Stripe's own webhook confirming a real payment event.

## Admin dashboard login

There's a separate, founder-only `site/admin-dashboard.html`, giving an
at-a-glance view across every business (active status, lead counts,
message/token usage) and a manual on/off switch per business. It's
completely separate from the client dashboard above, not an extension of
it:

- A second, separate cookie (`__Host-admin-session`) - the two logins can
  never be confused with each other, and a business owner's session can
  never grant admin access no matter what.
- Eligibility is a small allowlist of specific emails (an environment
  variable, not a database), re-checked on every single request rather
  than only at login - removing someone from that list logs them out
  immediately, not whenever their session would otherwise have expired.
- The admin "deactivate" switch only flips the same `active` flag Stripe's
  own webhook already sets automatically on a real cancellation - it does
  not touch billing or cancel a subscription. Actual billing changes still
  only ever happen in Stripe's own dashboard, which the admin page links
  to directly per business.
- Admin can also edit a business's name/type/phone/notification email
  directly (for support, e.g. fixing a typo), and can "view as" a
  business to see their dashboard exactly as they do, for troubleshooting.
  Both are logged (who, which business, when) and rate-limited separately
  from everything else in the dashboard, specifically because a compromised
  admin session is a categorically bigger risk than a compromised business
  session - the latter can only ever touch its own data. Viewing as a
  business is clearly flagged on that business's own dashboard while
  active, and never changes or exposes anything the admin couldn't already
  see through the admin list itself.

## How the live AI backend stays safe

A public, unauthenticated AI endpoint is a genuine cost and abuse surface
if it isn't built carefully, so:

- The system prompt locks the assistant to only the practice's own FAQ
  information - it's explicitly instructed to refuse general knowledge
  questions, refuse instructions embedded in a visitor's message trying to
  change its behavior, and never give medical advice, diagnosis, or
  triage - anything pain/symptom/emergency-related is redirected to
  calling the practice, every time.
- Input length, conversation length, and requests-per-minute are all
  capped server-side.
- A hard monthly spending cap is set directly in the AI provider's own
  dashboard - the real backstop against runaway cost, independent of
  anything the widget or server code does.
- Only a short excerpt of a conversation is ever stored, and only when a
  visitor actually leaves contact details (see "Lead capture" above) - a
  conversation that never results in a lead leaves no transcript anywhere.
  Separately, a question the AI couldn't answer is logged on its own,
  without any visitor identity attached to it.
- HTTPS only, throughout.

**Known limitation, stated plainly:** the per-minute rate limit currently
runs in the serverless function's own memory, which resets between cold
starts - a reasonable first safety net, but not a guaranteed one under
sustained abuse. A shared, persistent rate-limit store is the right
upgrade once this is serving real paying clients rather than a handful of
demos, and the provider-side spending cap is what actually bounds worst-
case cost in the meantime.

## WhatsApp channel

A business can optionally also connect a WhatsApp number, so visitors
can message it directly and reach the same AI receptionist, same FAQ
knowledge, same hard rules (no medical advice, no instruction-following
from message text, etc.) as the website widget - not a separate, less-
guarded bot.

- Runs on Meta's own WhatsApp Business Platform (Cloud API) - messages
  are relayed through Meta's infrastructure, the same as any WhatsApp
  Business integration, never through a third party beyond Meta and
  Anthropic (the AI provider already used for the website widget).
- Every incoming message is cryptographically signature-verified
  (HMAC-SHA256 against Meta's own App Secret) before anything is
  processed, the same discipline already applied to Stripe's webhook -
  an unsigned or forged request is rejected outright.
- Each inbound message is processed exactly once even if Meta's own
  retry mechanism re-delivers it (a documented, normal part of how
  webhook delivery works) - an atomic claim keyed on Meta's own message
  id prevents a visitor ever receiving a duplicate reply, and prevents
  a business ever receiving two notification emails for one lead.
- A visitor's WhatsApp number is their own contact detail on that
  platform already - unlike the website widget (which has to ask, and
  only ever captures what's typed in reply), there's nothing additional
  to "give" here; the number is only ever used to reply to that
  conversation and, if the AI judges it a genuine enquiry, to notify the
  business - never anything else.
- Conversation history (so the AI has context across a sender's
  messages - WhatsApp has no equivalent of the widget's own in-browser
  history) is kept only as a short rolling window per sender, expiring
  automatically after 48 hours of inactivity.

## Hosting

Demo/static assets are served over HTTPS. The chat and lead-capture
backends are small serverless functions holding no data beyond the current
request. A business's own config (name, FAQs, phone, colors) is a real,
version-controlled file in this project's git repository - not a database,
but a genuine persistent store, and Stripe separately holds payment/
subscription data for paying customers (never card numbers themselves,
which Stripe's own hosted checkout collects directly).

## Automated trial signup

A visitor can start a 7-day free trial directly from the website with no
human involved on our side:

- **Card is collected upfront, by Stripe's own hosted checkout page** -
  never by us, never touching our servers. Stripe automatically charges
  the standard monthly rate the moment the 7-day trial ends, unless
  cancelled first.
- **Webhook calls are cryptographically signature-verified** before
  anything is processed - an unsigned or forged request is rejected
  outright, so nothing can trigger a config publish except a genuine event
  from Stripe.
- **Every field in a self-serve signup is sanitized and hard-capped again,
  server-side, before being committed** - the same defense-in-depth
  posture as the free preview tool, extended to anything that becomes a
  real, permanent, publicly-answering config. An uploaded photo/logo is
  validated server-side (image type restricted to PNG/JPEG/WebP/GIF - no
  SVG, since that format can embed scripts; 2MB size cap) before being
  stored, and a config's avatar can only ever point at that upload path or
  one of the built-in preset faces - never an arbitrary attacker-supplied
  URL.
- **Cancelling actually takes the widget offline.** If a trial is
  cancelled, or a renewal charge fails, the business's config is flipped to
  inactive and the widget itself refuses to load its normal chat panel for
  that business - it does not keep quietly answering for free.
