# Frontdesk — security & data overview

Written to be handed directly to a prospect's IT contact or practice manager
during evaluation. Plain language on purpose.

## What it is

A single `<script>` tag that adds a chat widget to your website. Nothing
else changes on your site — no plugin install, no admin access needed, no
dependency on your CMS or hosting platform.

## How it's isolated

- The widget renders inside a **Shadow DOM** — a browser-native sandbox.
  Your site's CSS cannot affect the widget, and the widget's CSS/JS cannot
  affect your site. No class-name collisions, no layout breakage.
- It does not modify, read, or interact with any other element on your
  page. It only adds itself.
- No inline scripts or styles are injected into *your* document — only
  into its own isolated shadow root — so your site's own Content Security
  Policy is unaffected.

## Data handling

- All visitor-typed text is rendered using `textContent`, never
  `innerHTML` with unescaped input — this closes the standard XSS vector
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
  analytics or ad scripts of any kind.
- The widget explicitly avoids soliciting or storing symptom/health
  information — questions that sound medical (pain, emergency, "hurts")
  are redirected to "please call the practice," not answered by the bot.
  This is a deliberate scope boundary, not an oversight: a booking/FAQ
  assistant should not be doing anything that resembles triage or medical
  advice.

## Lead capture

When a visitor chooses to leave their name and contact details (always
opt-in — never collected automatically or without them clicking "leave
your details"), that information is emailed directly to the business's
own configured notification address and is not stored in any database on
our side. The last few messages of that conversation are included in the
notification so the business has context on what the visitor was asking.
If email delivery fails for a live client, the visitor is told honestly to
call instead, rather than being shown a false "success" message that could
leave a real inquiry lost with nobody aware of it.

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
- No storage of full conversation transcripts by default; only aggregate
  usage counts, unless a practice specifically opts in to transcript
  logging (e.g. for reviewing missed questions) and that's documented
  separately in writing before it's switched on.
- HTTPS only, throughout.

**Known limitation, stated plainly:** the per-minute rate limit currently
runs in the serverless function's own memory, which resets between cold
starts - a reasonable first safety net, but not a guaranteed one under
sustained abuse. A shared, persistent rate-limit store is the right
upgrade once this is serving real paying clients rather than a handful of
demos, and the provider-side spending cap is what actually bounds worst-
case cost in the meantime.

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
