# Frontdesk

A single-script-tag AI chat widget for local business websites — answers
common patient/customer questions (hours, services, booking, location),
captures leads it can't answer, hands off anything urgent to a phone call.
Sold direct as a monthly subscription — no marketplace cut.

First target: **West London Dental Centres** (dentistw4.co.uk), Chiswick.

## Bug fixes from real usage feedback

- **Bot replies invisible on some host pages - a real gap in the isolation
  promise.** `.fd-msg.fd-bot` never set its own text color, so it silently
  inherited whatever color the *host page* uses - `color` is an inherited
  CSS property and crosses the Shadow DOM boundary unless explicitly reset,
  unlike the non-inherited properties Shadow DOM blocks automatically. On
  a dark host page with light body text (exactly what our own site is),
  that leaked straight into the widget's white message bubbles, producing
  near-invisible light-on-white text - confirmed from a real screenshot,
  then reproduced and fixed: added `color: #1a1a1a` to `.fd-root` as an
  explicit baseline. Verified against the exact reported case (computed
  color was `rgb(26, 26, 26)` on white afterward, confirmed visually too).
- **Contrast bug, real not hypothetical.** White text on the accent color
  was hardcoded everywhere (header, buttons, user messages). Turns out
  even the new default coral (`#ff7a59`) only has a 2.6:1 contrast ratio
  with white - fails WCAG AA, and any pale custom color (tested with
  `#f5e6a8`) made text nearly invisible. Fixed with `contrastTextColor()`
  - computes perceived brightness of whatever accent color is set and
  picks white or dark text automatically. Verified against the exact
  failing pale-yellow case: correctly switched to `#1a1a1a`.
- **No feedback on buttons/pricing cards.** The pricing plan cards had
  literally no click target - clicking them did nothing because there was
  nothing to click. Added real `.plan-cta` buttons to both plans, plus
  hover/active states (lift + brightness on hover, press-down on click)
  across every button on the site, not just the new ones.
- **No pay button - correctly diagnosed, not a bug.** There's genuinely no
  checkout yet; Stripe still isn't connected. Added working "Get started" /
  "Ask about setup" buttons that open a pre-filled email for now, so
  clicking does something real instead of nothing - swap the `href` to the
  real Stripe Payment Link the moment it exists.

## Drawing the eye before it's opened

The closed bubble used to just sit there statically. Now: pops in with a
little spring on page load, a soft breathing glow while idle (color-matched
to each business's own accent color via `color-mix()`), an irregular blink
on Ivy's drawn eyes (only the default face - never animates a business's
own uploaded logo), and a one-time, dismissible teaser bubble ("👋 Got a
question? I'm Ivy.") that appears after ~4.5s and auto-hides after 9s if
ignored. All of it stops the instant someone actually opens the panel -
the goal is a first glance, not a nagging loop. Verified the full
lifecycle live: pop-in and pulse active on load, teaser appears on
schedule, and clicking it opens the panel, stops all animation, and
removes the teaser cleanly.

## Visual identity — "Ivy"

The widget was competent but generic - looked like every other blue SaaS
chat bubble (Intercom, Drift, Tawk.to). Redesigned around an actual
identity instead of a chat icon: every install's assistant is named
**"Ivy"** by default (`theme.assistantName` to override), with a warm
illustrated face (inline SVG, not a fake stock-photo human - honestly
not-a-real-person, but alive and friendly) rather than a generic
speech-bubble outline. The panel now has a rounded speech-bubble tail
connecting it back to the bubble it came from, softer corners throughout,
and a warm coral default accent (`#ff7a59`) instead of corporate blue -
though a business's own brand color, once set, always wins. Verified
backward-compatible: the existing dentist config (no `assistantName`, no
`avatarUrl`) picked up the new defaults automatically while keeping their
own blue accent color untouched.

## What's built

- `widget/frontdesk-widget.js` — the embeddable widget. Shadow-DOM
  isolated, mobile-responsive, XSS-safe, single `<script>` tag integration.
  Verified in browser preview at both desktop and mobile widths, and the
  FAQ-matching logic tested end-to-end (question in, correct answer out).
- `configs/dentistw4.json` — real public info only (services, hours-page
  content, location, phone, NHS/private, Invisalign, implants, whitening)
  scraped from their live site. No fabricated claims.
- `demo/dentistw4.html` — working demo page, ready to deploy and link to
  in outreach.
- `SECURITY.md` — plain-language data/security overview for whoever
  reviews this on the prospect's side.
- `outreach/dentistw4-email-draft.md` — draft cold email, **not sent**.
- `api/chat.js` — Vercel serverless function proxying to Claude Haiku,
  scoped system prompt, input/history/rate caps, graceful fallback to
  keyword matching on any failure. API key is a server-side env var only,
  never in client code. Not deployed yet - needs your Anthropic API key
  (see "What needs you" below).
- `tools/config-generator.html` — fill in a form (business info, theme,
  FAQs), get a valid config JSON + the exact install snippet back. This is
  what makes personalizing prospect #2, #3, #50 fast instead of hand-
  writing JSON each time. Tested end-to-end (form → generated JSON →
  validated it parses correctly).
- **Site redesign + live "preview your business" tool.** The site now leads
  with pricing (no scrolling to find the number) and a real interactive
  preview: type in a business name, type, and phone, and it mounts a second,
  independent widget instance right there using the actual widget's new
  `window.FrontdeskWidget.mount()` API - not a mockup screenshot, the real
  thing, personalized live. Deliberately kept AI-free (runs on the same
  local keyword-matcher as the safe fallback elsewhere) since this config
  is built from arbitrary page input, not something we've reviewed - no
  reason to give that access to a live AI backend. Found and fixed a real
  bug while testing this: the preview and the generic example widget
  stacked exactly on top of each other at the same screen position: fixed
  by swapping out the generic one the first time a real preview is
  generated, so there's only ever one bubble on screen.
- **Business-hours awareness.** Optional `hours` field per config (per day,
  open/close times). Outside those hours, the greeting and header subtitle
  automatically switch to an `afterHoursGreeting` - verified live (tested
  at 11:21pm against 8am-6pm hours, correctly showed the closed-but-still-
  helping message). This is the single most demo-able feature for
  convincing a skeptical owner: it visibly proves the "works while you're
  asleep" pitch instead of just claiming it.
- **Responds in the visitor's language** - one line added to the AI system
  prompt (`api/chat.js`). Claude does this natively; needed to be told to,
  not built from scratch.
- **Thumbs up/down on every bot answer** - real signal on which FAQs are
  actually landing, not just a UI flourish. Currently logs client-side only
  (no backend wired up for it yet - same honest "not built yet" treatment
  as everything else still pending an account).
- Message entrance animation for a more premium feel.
- Theming is now config-driven beyond just color — `theme.position`
  (left/right), `theme.avatarUrl` (business logo in the bubble/header),
  `theme.accentColor`. Each business's config controls its own look; the
  widget code never needs touching per-client.
- `INSTALL.md` — copy-paste install steps for WordPress, Squarespace, Wix,
  Shopify, and plain HTML. This is what makes genuine self-serve possible,
  and also the natural upsell: businesses that don't want to touch any of
  this are exactly who pays extra for the "we'll install it for you" tier.
- `site/index.html` — the actual company site, with the widget live on it
  using a fictional example business. Tested end-to-end (asked it a real
  question, got the right answer). This is the better outreach destination
  going forward - answers "who is this and how does it work," not just
  "here's a mockup."
- `api/lead.js` + the widget's "leave your details" form — real lead
  capture. Visitor opts in, fills name + contact, it's emailed straight to
  the business's configured address (never stored in a database on our
  side) along with recent conversation context. Tested end-to-end: form
  submission, missing-field validation, unknown-business handling, and the
  "not configured yet" safe fallback all verified. Needs a Resend account
  (see below) to actually deliver for a real client - until then it logs
  server-side instead of silently losing leads.

## Deliberate scope decisions (read before extending)

- **AI backend is built but needs your API key to go live.** Until then,
  the widget runs on local keyword-matched FAQs (same safe fallback it
  uses if the AI backend is ever down). A public, unauthenticated AI
  endpoint is a real cost/abuse surface, which is why it's scoped tightly:
  system prompt locked to this business's own info, medical questions
  always redirected rather than answered, input/history/rate caps
  server-side, and a hard spending cap you set directly in the Anthropic
  console as the real backstop. Full detail in `SECURITY.md`.
- **No medical/triage behavior.** Anything that sounds like pain, an
  emergency, or a symptom is redirected to "please call" rather than
  answered — both a liability and regulatory boundary, deliberately kept
  out of scope for a healthcare client.
- **Config-driven, not per-client-forked.** New prospects = a new JSON
  config, not a new copy of the widget code. Keep it that way as more
  demos get built.

## What needs you, next

1. **Create an Anthropic API account** (console.anthropic.com), add
   billing, and — importantly — set a hard monthly spending cap there
   before this goes live. Share the API key with me only as an env var
   (never in chat) so I can set it in Vercel.
2. **Create a Resend account** (resend.com, free tier available) for lead
   notification emails, and verify a sending domain there. Share the API
   key the same way - env var, never in chat.
3. **Fill in the dentist's real notification email** — `configs/
   dentistw4.json` currently has a placeholder (`TODO-add-real-contact-
   email@example.com`) since I don't have their real one from the public
   site. Needs a real address before this goes live for them.
4. **Deploy to Vercel** (same GitHub → Vercel pattern as `rush-app` and
   `miser-ai`) — `api/chat.js` and `api/lead.js` both need Vercel
   specifically (or another Node serverless host), not a plain static
   host.
5. **Set up Stripe** for Frontdesk specifically (separate from anything
   set up for `miser-ai`) - a Payment Link is enough to start, no need to
   build full subscription infrastructure before there's a first client.
6. **Check for a named contact** (practice manager/owner) before sending
   the outreach email — noted in the draft.
7. **Review and send the email yourself** — I don't send messages on your
   behalf without you reviewing them first.
