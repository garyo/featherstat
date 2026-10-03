# 11 — Installing the tracker

The operator's guide: what to paste into a site, and the handful of things that
go wrong afterwards. docs/04 § 1–2 is the wire contract this rests on; this doc
is the part a person follows.

## 1. Add the site

Settings → Sites → Add. You need a name, the domains it serves from (every
hostname, including `www.`), and the site's IANA timezone — `local_date` and
`local_hour` are computed at ingest from it. Changing it later re-dates the
site's stored history in the background, but not the days retention has already
pruned, and unique-visitor counts on re-dated days become approximate (docs/03
§ Timezones) — so get it right at the start.

Note the numeric **site id**; the snippet needs it.

## 2. Paste the snippet

New sites use the native tracker. `<head>`, as early as convenient:

```html
<script type="module">
  import { init, page } from 'https://analytics.example.com/tracker.js'
  init({ site: 1, endpoint: 'https://analytics.example.com/api/collect' })
</script>
```

That is the whole install. `init` hooks `history` for pageviews, delegates
outlink and download clicks, and starts focus- and idle-gated engagement pings.

**Single-page apps that route themselves** should opt out of the history hook
and announce their own views, so the view is announced *after* the app has
swapped the document (the hook fires on `pushState`, when `document.title` is
still the outgoing page's):

```html
<script type="module">
  import { init, page } from 'https://analytics.example.com/tracker.js'
  init({ site: 1, endpoint: '…', autoPageviews: false })
  page()                                   // the first view; see below
  document.addEventListener('astro:page-load', () => page())
</script>
```

Announce the first view explicitly rather than leaving it to the router's
event: the module import is a network fetch, and a framework's ready event has
usually fired before it resolves. If the two ever race the other way, the
tracker's repeat-view guard collapses them into one.

Existing Matomo sites keep their `_paq` snippet and point `setTrackerUrl` at
`/matomo.php` (docs/04 § 1, docs/06). The shim is a compatibility surface: it
**never carries custom props**, permanently.

## 3. Do not let "page not found" become a page

**This is the one everybody gets wrong, and it is invisible until it isn't.**

A 404 page is a page. It runs your layout, so it runs the snippet, and the
tracker reports the URL that was *asked for*. Nothing client-side can see the
HTTP status — the tracker is JavaScript on a page that has already been served,
and `location.pathname` is all it has. So every mistyped link, every dead
inbound link, and every scanner sweep files itself as a genuine page.

It is not a rounding error. One compliance scanner probing a site for the usual
legal-page locations — `/privacy-policy`, `/terms`, `/gdpr`, `/cookie-policy`,
`/legal/privacy`, and two dozen more — produced **28 phantom pages in a single
visit**, all with measured dwell, which then dominated that site's "Time on
page" card for the day.

Mark the 404 page, and report the path that was asked for:

```html
<!-- on the 404 template ONLY -->
<meta name="featherstat:missing" content="1" />
```

```js
const view = () =>
  document.querySelector('meta[name="featherstat:missing"]')
    ? page(new URL('/404', location.origin).href, document.title, {
        missing: location.pathname.slice(0, 200),
      })
    : page()
view()
```

A page view carrying `missing` is then not traffic at all (docs/03 § Not-found
hits): it opens no visit, counts toward no visitor, page view or bounce, and the
tracker sends nothing more from that page. It is recorded apart — the path asked
for, and the page that linked to it — and the **Broken links** card on the
Content dashboard ranks those paths, linked-to ones first, so a dead inbound
link is one row with the page to go and fix. A scanner sweeping hundreds of
paths is counted past 500 a day rather than stored.

A meta tag rather than a build-time flag because it is stack-agnostic: any
templating system can emit one tag on one template, and the snippet stays
identical everywhere.

**On the Matomo shim** there is no way to say so — the shim carries no props —
so the best it can do is collapse the URL. The hit stays an ordinary `/404`
page view, counted as traffic:

```js
if (document.querySelector('meta[name="featherstat:missing"]')) {
  _paq.push(['setCustomUrl', location.origin + '/404'])
}
_paq.push(['trackPageView'])
```

### Sites with no 404 at all

Worse and more common than a tracked 404: a static host that answers **200**
with `index.html` for every unknown path. There is no 404 template to mark,
the status code is a lie, and every garbage URL is a real pageview of a real
path. It is usually a one-line hosting setting, switched on by a template and
never revisited — a single-page site is exactly the case where nobody notices,
because the app renders happily at any URL.

On Cloudflare (Workers assets or Pages), the culprit is:

```toml
[assets]
not_found_handling = "single-page-application"   # 200 + index.html for everything
```

Set it to `"404-page"` and ship a `404.html` — in Astro, add
`src/pages/404.astro`; the build emits the file and Cloudflare serves it with a
real 404. A Pages project configured through the dashboard has the same setting
there rather than in `wrangler.toml`. Other hosts spell it differently
(`try_files … /index.html` in nginx, a `/* /index.html 200` line in
`_redirects`), and the fix is the same shape: only fall back to the app for
routes the app actually owns.

Once the host serves a real 404 page, mark it as in § 3 above and nothing
special is needed. If you cannot change the host, a genuinely single-page site
can fall back to letting the app assert its own routes:

```js
// this site is one page: any other path does not exist
if (location.pathname !== '/' && location.pathname !== '/index.html') {
  page(new URL('/404', location.origin).href, document.title, {
    missing: location.pathname.slice(0, 200),
  })
}
```

### Checking a site

Ask for a path that cannot exist and see what comes back:

```bash
curl -sSL -o /dev/null -w '%{http_code}\n' https://example.com/zz-probe-404/nope
curl -sSL https://example.com/zz-probe-404/nope | grep -o 'tracker\.js\|matomo\.js'
```

`404` and no tracker is correct. `404` **with** a tracker means § 3 applies.
`200` means the site has no 404 handling at all.

## 4. The other things worth checking once

- **Every hostname is registered.** A hit from a host the site does not claim
  still records. `www.` is the usual straggler.
- **The snippet runs on production only**, or dev sessions land in the
  reports — `if (location.hostname === 'example.com')` around it is enough.
- **Verify with the live feed.** Settings → Diagnostics and the Realtime page
  show hits as they arrive; a beacon never bounces (invariant 4), so a
  misconfigured snippet fails silently and this is how you see it.
- **Bots**: obvious crawlers are dropped at ingest and counted in the
  diagnostics bot-drop counter. Anything driving a real browser engine with a
  real user-agent is indistinguishable from a person and will be recorded —
  which is what makes § 3 matter.
