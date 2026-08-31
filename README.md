# Frontdesk

A single-script-tag AI chat widget for local business websites — answers
common patient/customer questions (hours, services, booking, location),
captures leads it can't answer, hands off anything urgent to a phone call.
Sold direct as a monthly subscription — no marketplace cut.

First target: **West London Dental Centres** (dentistw4.co.uk), Chiswick.

## Future idea: a premium tier that takes payment in-chat (not built yet)

Instead of just capturing a lead for the business to follow up on, Ivy
closes the transaction herself - customer books and pays right in the
widget. Noted here so it doesn't get lost, deliberately **not** scoped for
now - it's a materially bigger build than anything else in this project:

- Needs real availability/calendar data, not just FAQ config - can't sell
  a slot without knowing what's actually free.
- Needs **Stripe Connect**, not a simple Payment Link - money has to land
  in each business's own account, so every client onboards their own
  connected Stripe account (KYC, payouts) and the backend routes to the
  right one per transaction.
- Raises the error budget a lot - a bug here means misplaced money or a
  double-booked slot, not just a missed FAQ answer, so it needs more
  careful building/testing than anything shipped so far.

Right sequencing: after client #1 is real and paying, not before. Also a
legitimate premium-tier price justification once it exists - "closes
sales while you sleep" is worth noticeably more than £45/mo.

## Future idea: give Claude read-only Stripe access (not built yet)

Once there are real paying clients, it'd be useful for Claude to answer
things like "how many are actually paying right now," "did anyone's
payment fail this month," "what's MRR" - direct reporting instead of
digging through the Stripe dashboard by hand.

**How, when we get there:** a Stripe **Restricted API key**, scoped to
read-only on Payment Links / Subscriptions / Charges specifically. No
refund, payout, transfer, or account-settings permissions on that key -
ever. Stored the same way as the other secrets (env var, never pasted
loosely in chat).

**Hard line, not just a preference:** anything write/mutating - issuing a
refund, cancelling a client's subscription, changing payout details,
creating new pricing products - stays prepare-but-don't-execute even with
that key in hand. Claude drafts the action, a person clicks confirm. This
isn't extra caution for its own sake - it's the same boundary Claude
already operates under around moving money, and it matches Stripe's own
least-privilege guidance for exactly this kind of access.

**Timing:** not urgent - nothing to report on with zero paying clients.
Worth doing once there's real subscription activity to actually watch.

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
- **Site redesign + live "Make your AI receptionist" tool.** The site now
  leads with pricing (no scrolling to find the number) and a real
  interactive preview: name the AI, pick or upload its face, fill in the
  business, and it mounts a second, independent widget instance right
  there using the actual widget's `window.FrontdeskWidget.mount()` API -
  not a mockup screenshot, the real thing, personalized live. Runs on the
  **real Claude backend** (`sendConfigInline`: the visitor's own draft
  config travels with each chat request instead of needing a config file
  on disk first), sanitized and capped server-side exactly like a real
  client's config (see `sanitizePreviewConfig()` in `api/chat.js`) - proven
  resistant to a direct prompt-injection attempt typed into the business
  name field. A free-text box (100 chars, capped both client- and
  server-side) lets the visitor teach it one real fact about their
  business, which then actually shows up in the AI's answers - verified
  live end-to-end (typed a made-up fact, asked a question only that fact
  could answer, got it back correctly). Found and fixed a real bug while
  testing the original version of this: the preview and the generic
  example widget stacked exactly on top of each other at the same screen
  position: fixed by swapping out the generic one the first time a real
  preview is generated, so there's only ever one bubble on screen.
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
- **Automated signup: pay, get a live config, get your snippet - no human
  step.** Previously, a customer paying via Stripe still needed someone to
  hand-write their config, commit it, and email them an install snippet.
  Now: `api/create-checkout.js` starts a real Stripe Checkout Session for a
  7-day free trial (card collected upfront, so Stripe auto-charges the
  standard rate the moment the trial ends - no manual "chase payment"
  step), `api/stripe-webhook.js` verifies the signed `checkout.session.
  completed` event and publishes `configs/{key}.json` by committing it
  straight to this repo via the GitHub API (the same auto-deploy pipeline
  that already publishes every other config, just done by an API call
  instead of by hand), and `site/success.html` polls until it's live and
  hands over the real install snippet. `shared/build-config.js` is the one
  place that turns a draft into a config, shared by the free preview tool
  and the webhook so they can never drift into two different shapes.
  Cancelling (or a failed renewal) flips the config to `active: false` via
  `customer.subscription.updated`/`.deleted`, and both the widget itself
  and `api/chat.js`/`api/lead.js` refuse to operate for an inactive
  business - cancelling actually takes the bot offline, not just stops
  billing.
- **Real photo/logo upload, for real - not preview-only.** The self-serve
  tool's avatar picker is now a single upload circle with a live preview
  (the old 6-preset gallery is gone). Since Stripe Checkout metadata caps
  each value at 500 characters - far too small for an actual image -
  `api/upload-avatar.js` commits the uploaded photo to this repo *before*
  checkout starts (same GitHub-as-storage pattern as configs themselves,
  reusing `api/_lib/github.js`), and only a short filename reference travels
  through Stripe. The webhook resolves that reference back into a real URL
  when it publishes the config. Validated server-side regardless of what
  the browser already checked: image MIME type restricted to PNG/JPEG/
  WebP/GIF (SVG deliberately excluded - it can embed scripts), 2MB cap,
  and `api/_lib/config.js`'s `sanitizeCommittedConfig()` only ever accepts
  an avatar URL matching our own generated upload path or one of the
  legacy presets - never an arbitrary caller-supplied URL.

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
- **Committed-to-git configs, not a database, for now.** Automated signup
  publishes configs by committing to this repo rather than provisioning a
  real datastore - zero new paid infrastructure, reuses the exact pipeline
  that already publishes every hand-written config, at the cost of a ~1-2
  minute delay after payment before a business's config is actually live
  (handled honestly with a wait screen on `site/success.html`, not a fake
  instant success). Worth revisiting for a real database once signup volume
  makes that delay or the "each signup triggers a redeploy" pattern a
  genuine problem, not before.
- **Uploaded avatars live in `configs/avatars/` forever, with no cleanup
  path yet.** Every photo ever uploaded through the self-serve tool gets
  committed and stays, even if that visitor never actually pays - low
  volume makes this a non-issue today, but worth a cleanup job (delete
  orphaned uploads with no matching config after some window) once there's
  real traffic through this tool.

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
   set up for `miser-ai`). The original static Payment Link was enough to
   start; automated trial signup (see below) now needs real API access
   instead.
6. **Check for a named contact** (practice manager/owner) before sending
   the outreach email — noted in the draft.
7. **Review and send the email yourself** — I don't send messages on your
   behalf without you reviewing them first.
8. **Find the Price ID behind the existing £45/mo product** — Stripe
   Dashboard → that product → copy the `price_...` id (don't create a new
   product) — into `STRIPE_PRICE_ID`.
9. **Add a Stripe webhook endpoint** at `https://<your-domain>/api/stripe-
   webhook`, subscribed to `checkout.session.completed`, `customer.
   subscription.updated`, and `customer.subscription.deleted` — copy its
   signing secret into `STRIPE_WEBHOOK_SECRET`. Do this after the first
   deploy with the new code, since the endpoint needs to exist first.
10. **Create a GitHub fine-grained personal access token**, scoped to only
    this repo, **Contents: Read & Write** and nothing else — into
    `GITHUB_TOKEN` (plus `GITHUB_OWNER`/`GITHUB_REPO`). Fine-grained tokens
    expire (max 1 year) — worth a calendar reminder to rotate it.
11. **Decide on Stripe's dunning/retry settings** (Billing settings) — how
    many times a failed renewal charge retries before the subscription is
    marked cancelled controls how fast a client's bot goes dark after a
    card fails. A business/legal call, not a coding one.
12. **Decide whether to deactivate the old static Payment Link** once the
    new trial flow is live — it currently bypasses the trial, the webhook,
    and the automation entirely (immediate charge, no config auto-
    published). Your call, since the link may already be shared somewhere.
13. **Sign off on the trial/auto-charge wording** on the pricing section
    before this goes live to real prospects — it should read clearly as
    "card required, charged automatically after 7 days" with no surprises.
