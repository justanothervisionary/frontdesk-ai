# Installing Frontdesk on your website

One snippet, works anywhere. Pick your platform below — most take under
five minutes. If you'd rather not touch any code, that's what the setup
service is for; just send us login access (or have your web person add it)
and we'll handle it.

Your snippet (from the config generator) looks like this:

```html
<script src="https://YOUR-DOMAIN/widget/frontdesk-widget.js"
        data-business="your-business-key"
        data-config-url="https://YOUR-DOMAIN/configs/your-business-key.json"
        data-api-url="https://YOUR-DOMAIN/api/chat"
        defer></script>
```

## WordPress

1. Go to **Appearance → Theme File Editor** (or, easier and safer: install
   the free **"Insert Headers and Footers"** plugin — avoids editing theme
   files directly).
2. Paste the snippet into the **footer** section.
3. Save. Refresh your site — the chat bubble should appear bottom-right.

If your theme has a dedicated "Header/Footer Scripts" box under
**Appearance → Customize**, that works too — same idea, fewer steps.

## Squarespace

1. **Settings → Advanced → Code Injection**.
2. Paste the snippet into the **Footer** box.
3. Save.

(Squarespace's code injection is a Business-plan-or-higher feature — worth
checking their current plan before promising this works.)

## Wix

1. **Settings → Custom Code** (or **Settings → Advanced → Custom Code**
   depending on Wix's current menu layout).
2. **Add Custom Code**, paste the snippet, set it to load on **all pages**,
   placement **Body - end**.
3. Apply.

## Shopify

1. **Online Store → Themes → Edit code**.
2. Open **theme.liquid**, find the closing `</body>` tag.
3. Paste the snippet just before it.
4. Save.

## Any other platform / plain HTML site

Paste the snippet just before the closing `</body>` tag on every page you
want the widget on — or in a shared footer/include file if your site has
one, so it only needs adding once.

## After installing

Open the site in an incognito/private window and confirm the chat bubble
appears and responds. If it doesn't show up, the most common cause is the
snippet landing in a page template that isn't actually used site-wide —
double check it's in the real global footer/header, not just one page.

---

**Prefer we just handle it?** That's the paid setup option — send us
access (or loop in whoever manages your site) and we'll install and test
it for you.
