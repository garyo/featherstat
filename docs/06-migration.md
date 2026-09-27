# 06 — Migration from Matomo

Two audiences, and they want opposite things. Everything below "Importer" is
the record of *this* deployment's cutover — a specific migration, mostly a bake
log. The section immediately following is the general one: what any operator
arriving with a running Matomo should do.

Goal: zero tag changes, zero data gap, and a cutover that is boring. Matomo
stays untouched until the new system has proven itself on live traffic.

## Already running Matomo? (any operator)

There are two ways in, and the choice is not about taste — the paths have
different capabilities.

**Dual-run (default).** Add the native snippet from Settings and leave Matomo
exactly as it is. Both collect; compare for as long as you like; delete the
Matomo tag when convinced. This is the only path that lets you compare, and it
is why Settings offers the native tag and nothing else.

**Repoint (when editing the tag is expensive).** Change `setTrackerUrl` to
`https://<your-featherstat>/matomo.php` and the script `src` to
`.../matomo.js`. One string in one place, so this wins when the tag lives in a
tag manager, a CMS theme you don't control, or across dozens of sites. The cost
is that it is a **switch, not a comparison**: Matomo stops receiving the moment
you repoint.

**You cannot do both at once.** The compatibility shim claims `window._paq`,
and so does real matomo.js — one global, two owners, and load order decides who
loses. `browser.ts` guards against a second copy of *itself*; it cannot know
about Matomo's. So dual-running means the native tracker, always.

Expect the numbers to differ during any comparison. Visits read ~4 % below
Matomo (a heartbeat does not start a visit), bounce rate reads lower
(engagement-aware), average times read lower (accrued attention, not a span),
and page views read below Matomo on SPAs by that site's double-fire rate. Each
is a deliberate definitional divergence with its reasoning under "Changes made
during the bake that move numbers" — none is an accounting error to chase.

Historical data is a separate question from tagging; the importer below reads a
Matomo MariaDB directly. This deployment ran it and then dropped the result on
purpose ("History was dropped"), for reasons that do not generalize to a
Matomo with years behind it.

History was *also* a goal until 2026-07-30, when it was deliberately dropped —
see "History was dropped" below. The importer still works and this document
still describes it, because the reasoning that made dropping it right here
(a week of history, two invariant violations, all of them in imported rows)
does not generalize to a migration with years behind it.

## Importer

`analytics import matomo` — a one-shot CLI in `apps/server`, reading the
Matomo MariaDB directly (over the Docker network or an SSH tunnel; read-only
credentials).

| Matomo source | Destination | Notes |
| --- | --- | --- |
| `matomo_site` | `sites` | ids preserved verbatim (R2); alias URLs → `domains` |
| `matomo_log_visit` | `sessions` | `idvisitor` (8 bytes) → `visitor_id`; `visit_first_action_time`/`visit_last_action_time` → timestamps; `visit_total_time` → `engaged_ms` (best available proxy); `location_country/region/city`; `config_browser_name/os/device_type/resolution`; referrer fields → attribution. (No lat/lon: the `sessions` schema carries none — see 03; the visit's lat/lon is denormalized onto its event rows instead) |
| `matomo_log_link_visit_action` ⨝ `matomo_log_action` | `events` | pageviews, events (category/action/name/value), outlinks, downloads; `server_time` → `ts`; page URL/title from the joined action rows; visit lat/lon denormalized here |

Import details:

- `local_date`/`local_hour` recomputed from each site's timezone during
  import (Matomo stores UTC; same convention).
- Historical visitor ids don't chain with the new daily-rotating scheme —
  fine: unique-visitor counts are per-day-exact in both systems, which is the
  only guarantee we make anyway (03).
- Idempotent: high-water marks per source table (in `settings`) plus
  deterministic session ids derived from `idvisit`, so re-running tops up
  instead of duplicating. (This once enabled a final top-up import at cutover;
  that step is gone — see "History was dropped".)
- `--since YYYY-MM-DD` bounds a top-up AND re-reads the window's visits
  regardless of the watermark: Matomo mutates `log_visit` rows in place while
  a visit accrues actions, and the deterministic ids let those sessions
  upsert to their final state instead of staying frozen mid-visit.
- `--until YYYY-MM-DD` (exclusive) fences a top-up off from the tee period —
  see the cutover sequence below.
- Validation gate: for three spot-check months, per-site daily
  visits/pageviews from `/api/query` must match Matomo's API within rounding.
  Known definitional deltas (bot filtering, ping handling) get documented
  numbers, not hand-waving.

## v1 → v2 (featherstat's own migration)

Schema v2 is a clean-slate line at `user_version` 100; a v1 file (versions
1–5) is **never migrated in place**. A v2 binary pointed at one refuses to
start and names the fix: `featherstat import v1 <path>` — a one-shot importer
(`apps/server/src/import/v1/`, the `v1` subcommand of the same
`dist/import.js` the Matomo importer ships in).

```
bun run --cwd apps/server import -- v1 /path/to/v1/analytics.db [--into <target>] [--dry-run]
```

**Runbook: stop v1 → import → start v2.** The source is opened readonly, but
a v1 server still writing while the importer reads would fork history — the
rows it writes after the importer's scan passed them exist in neither file's
future. The importer enforces the fresh-start side of this: a target that
already has events is refused unless a crash left resume watermarks
(`import:v1:*` in the target's settings — re-running resumes, never
duplicates). A run that completes with every validation gate held clears
them, so the finished file counts as live from then on and a second import
into it is refused too.

What transfers, streamed in watermarked batches:

- **sites** verbatim, ids preserved.
- **events** in rowid order (fresh rowids, order preserved); **sessions** by
  their blob ids (upsert — idempotent). All shared columns 1:1; the v2-only
  columns (`props`, `utm_*_raw`) start NULL — except that utm values run
  through the shared campaign normalizer against the target's (typically
  empty) alias table, so imported history and live ingest agree on what a
  utm value means. The as-received value lands in `utm_*_raw` only when
  normalization changed it.
- **bot_drops** verbatim.
- **settings** via allowlist: `salt:*`, `uidsalt:*`, `uid_enabled:*`, the
  ntfy keys, `retention_days`. Salts imported = **zero visitor
  discontinuity** — the same hash inputs keep producing the same visitor ids
  across the cutover. Everything else is reported skipped by name (the admin
  password among them: set one on first v2 login).
- **dashboards** through the `upgradeDashboard` layout chain; name and site
  scope carried, `created_at` = the v1 `updated_at`, library order = the v1
  ids, `template` NULL. A layout no current vocabulary can carry is reported
  and skipped, never half-imported.

Dropped by design: **share_tokens** (re-mint — the raw tokens were never
stored anyway) and **admin_sessions** (re-login).

After the raw rows land the importer runs the full rollup rebuild
(`rollup/rebuild.ts`) — it inserts raw only — and then the validation gates,
exiting nonzero if any fails: per-table row counts; per-site/per-day visits,
pageviews, event counts, engaged_ms and distinct visitors computed by
*identical SQL on both files* and diffed to zero; and spot-check v2 queries
whose expected numbers are recomputed from the source by direct SQL.

One caveat, stated rather than hidden: utm **normalization may change utm
values** (that is its job), so utm-*grouped* numbers can differ from v1's by
design. The per-day gates never group by utm, so they hold exactly; the
report counts how many rows were normalized.

The same caveat, twice over, for the healing pass (docs/03 § Page identity):
**tracking params leave stored paths** (event paths and session entry/exit),
so path-grouped numbers merge v1's per-click variants onto one page; and a
row with **no utm whose path carried a platform click id** gets synthesized
first-touch attribution (facebook/social for `fbclid`, google/cpc for
`gclid`, …) exactly as live ingest now derives it — v1 booked those visits as
direct. The per-day gates group by neither path nor attribution, so they hold
exactly; the path spot-check aggregates the source through the same cleaning
rule; the report counts paths cleaned and attributions synthesized.

`--dry-run` reads and validates the source, prints all of the above as a
plan, and writes nothing — not even the target file.

## Live-traffic bake: tee mode

Before cutover, the new server runs with `MATOMO_FORWARD_URL` set: every hit
accepted at `/matomo.php` is **also forwarded** to the real Matomo — async,
fire-and-forget, **re-serialized from the normalized hit** (not byte-verbatim:
params outside our model, e.g. `pv_id`/custom vars, don't survive the round
trip), with the original client IP in `cip` (a sender's own `cip` override
wins, so the packzen webhook keeps its geo) and `token_auth` at the bulk level
only, never in the per-request strings Matomo logs. The forward URL must be
https (or loopback) — the token rides in the body. Then DNS/Traefik for
`analytics.example.com` is pointed at the new server:

- Sites need no changes at any point (R1).
- Matomo keeps recording everything, so it remains the fallback source of
  truth during the bake.
- The new system sees 100 % of real production traffic — realtime, geo,
  quirky UAs, the packzen webhook — for as long as confidence requires.

If the new system misbehaves: point Traefik back. Blast radius ≈ zero.

### History was dropped (2026-07-30)

The imported history is gone and the importer is no longer part of the cutover.
Gary's call, once the live invariant check found the only two violations in the
whole database were both in imported rows: *"Better to be correct going forward
and have strong tests than preserve a few days of questionable history."*

- Removed from production: 198 sessions and 254 events dated before tee-start,
  plus the three `import:matomo:*` watermarks. Zero visits straddled the
  boundary, so the cut was clean. Backup kept on the host as
  `analytics.db.pre-purge-20260730-1101`.
- Also removed: 19 heartbeat-only visits that featherstat itself recorded
  before `bbd4427` taught it that a ping does not start one. Phantom visits by
  the rule now deployed, and their engagement was attributed to no page anyway.
- What that bought: **every invariant passes against the live database**, so a
  violation now means a real defect rather than a legacy artefact. A check that
  always reports two known failures is a check nobody reads — the same way the
  entry-size ratchet went unread while it measured the wrong file.
- The scale made this easy and will not always: Matomo had been running about
  a week, so the whole of "history" was 254 events. Do not read this as a
  precedent for a migration with years behind it.
- Consequence: featherstat's data begins at tee-start, 2026-07-28. The
  importer still exists and still works; nothing in the cutover calls it.

### Changes made during the bake that move numbers

The bake compares our figures against Matomo's daily, so any change to what a
metric *means* has to be logged here or the comparison silently drifts.

- **2026-07-29 — `visits` under an event-level dimension** now counts distinct
  sessions over non-ping rows, matching the population `visitors` already used
  (52249a6). **Headline visits are unaffected**: ungrouped `visits`, and any
  `visits` answered from the `sessions` table, take the `COUNT(*)` path and did
  not move — so the daily per-site totals being reconciled against Matomo are
  unchanged. What moved is `visits` *within a breakdown* (by path, title, hour),
  where the old value counted heartbeat presence. On the replay corpus: 13 of
  121 groups by site×path, 6 of 35 by site×title, 184 of 6732 by
  site×day×hour; 41 of those previously reported visits > 0 against visitors =
  0 with no actions recorded at all.
- **2026-07-29 — `engaged_sessions`** returns 0 rather than NULL for a group
  matching no session (52249a6). Affects rendering of empty groups, not totals.
- **2026-07-29 — a heartbeat no longer starts a visit.** Headline `visits` DOES
  move here, downward, and this is a **deliberate definitional divergence from
  Matomo**, not an accounting error. A ping is a continuation signal, so with no
  live session it revives the visitor's own last session (returning-reader
  window, 4 h) and with nothing to revive it is dropped (docs/03 §
  Sessionization). Matomo, on the same 30-minute timeout, counts the reader who
  comes back to an open tab after half an hour as **two** visits; we count one
  visit with the attention of both — the owner's ruling: *"3 minutes, away half
  an hour, 3 more minutes should count as 6 minutes of engagement with that
  page rather than two visits."*
  - Production symptom that prompted it: **14 of 340 visits (4.1 %) had zero
    pageviews and zero events** — their first stored row was a ping. Those
    visits also credited their whole span of attention to no page at all,
    because per-page dwell drops events before a session's first pageview.
  - On the replay corpus, which now includes returning readers at production-ish
    prevalence: **visits 14385 → 13813 (−572, −3.98 %)**; pageview-less sessions
    764 → 192 (the 192 left are packzen's page-less webhook events, which are
    real actions); **heartbeat-only sessions 572 → 0**; stored event rows
    138249 → 137487 (−762 orphan heartbeats dropped, 0.55 %); `engaged_sessions`
    12014 → 11482 (−4.43 %); average engagement per engaged session 154.1 s →
    161.1 s (+4.6 %), since the two spans are now one visit.
  - **Bounce count barely moves** (2183 → 2181 on the corpus) because
    pageview-less sessions were never bounces — but **bounce *rate* rises**
    (0.1518 → 0.1579) purely because the denominator shrank. Expect the reported
    bounce rate to tick up by roughly the visit reduction, on top of the
    downward divergence from Matomo already described below.
  - Reconciliation note: on this pattern featherstat will read ~4 % below Matomo
    on visits every day. Do not chase it.
- **2026-07-29 — the all-sites cards' visitor figure** stopped being a sum of
  per-day distinct counts and became the range count the server does once. This
  is the only figure P2 (populations and measures) actually moves, and it moves
  **downward**, by roughly the share of readers who come back on a later day.
  The old number counted them once per day; the KPI tile on the same site's
  dashboard always counted them once, so the two screens disagreed under one
  label. The tile's number did not move — the card's now matches it.
  - On the replay corpus, all six sites together: a single day **171 → 171
    (unchanged**, as it must be — one bucket is one count); 7 days **934 → 923
    (−1.2 %)**; 30 days **4120 → 4063 (−1.4 %)**; the whole 93-day corpus
    **13009 → 12787 (−1.7 %)**. Per site over 30 days the spread is 0 % (site 3,
    no returning readers in the corpus) to **−4.2 %** (site 6).
  - Nothing Matomo is compared against changes: the daily per-site visitor
    totals the reconciliation uses are single-day figures, which are identical
    before and after. What moved is a multi-day card, which had no Matomo
    counterpart being tracked.
  - The card also gained the `~` approximation mark docs/03 always claimed the
    UI carried: a distinct count is exact within a day and an approximation over
    a longer range, because the id salt rotates daily.
- **2026-07-29 — `avg_engagement` became a server metric.** The value is
  **unchanged to the last bit** — it is the same `engaged_ms / engaged_sessions`
  the client was computing, verified identical on the corpus across a day, a
  week, a month and the whole window (132874.5793 / 151771.7710 / 158668.1447 /
  161121.9768 ms). What changed is where the division happens and that the
  sparkline beside it now re-derives the ratio from the declared components
  instead of running a second, differently-behaved copy of the arithmetic.
  Nothing to reconcile; logged because the metric vocabulary grew.
- **2026-07-29 — no other metric moved.** `bounce_rate` went from `AVG(pred)` to
  `SUM(pred)/COUNT(*)` and the hit-type counters from `SUM(type = 'x')` to
  `SUM(CASE WHEN type = 'x' THEN 1 ELSE 0 END)` as the population vocabulary
  took over; both are the same value in SQLite, and the replay oracles and the
  invariant sweep agree before and after.
- **2026-07-30 — the visitor-id salt rotates at site-local midnight**, not UTC
  midnight (docs/03 § Identity). Visitor counts shift *slightly*, and one visit
  in a hundred that used to be split at 20:00 local is now one visit.
  - **This is forward-only.** Rows already written keep the ids they were minted
    with; nothing re-hashes history. There is therefore **one transition day per
    site on which both boundaries appear**: hits from before the deploy carry
    ids minted under a UTC day, hits after carry ids minted under the local day,
    and a reader active on both sides of the deploy counts twice on that day.
    Expect exactly one day of slightly inflated visitors per site, then nothing.
    Do not reconcile that day against Matomo.
  - On the replay corpus, six sites, 90 days — **before → after**: visitors over
    a single day 171 → 170, 7 days 923 → 921, 30 days 4063 → 4054, the whole
    corpus 12787 → 12787 (unchanged in aggregate; per site it moves both ways:
    site 5 1261 → 1272, site 6 1015 → 1006, site 3 1660 → 1660 exactly, because
    site 3 *is* on UTC and has no boundary to move).
  - The reason to move it, in one line: the sum of a range's per-local-day
    visitor counts used to exceed the range's own count — 934 vs 923 over 7
    days, 4120 vs 4063 over 30, **13009 vs 12787 over the whole corpus (1.7 %)**
    — and now equals it exactly, in every window and for every site. Invariant
    10 in `test/replay/invariants.test.ts` asserts that equality and, as its
    anti-vacuity check, that the same corpus is still *not* additive over UTC
    days.
  - Sessionization moves with it, by about a tenth of a percent: visits
    13813 → 13799 (−14, −0.10 %), because a reader who stepped away at 19:50
    local and came back at 20:20 used to become a different visitor mid-evening
    and start a second visit. For the same reason **256 fewer heartbeats are
    dropped as orphans** (stored rows 137487 → 137743, +0.19 %; dropped pings
    4095 → 3839). Bounces 2181 → 2180; engaged sessions 11482 → 11469.
  - Nothing in the Matomo reconciliation is defined away: the daily per-site
    visitor totals it compares are single-day figures, and a single day still
    counts every id exactly once. They shift by well under a percent because the
    day they cover now starts and ends where the site's clock says it does —
    which is the boundary Matomo uses too.
- **2026-07-31 — leaving the page is a hit, so engagement rises.** Both
  trackers now send a final `ping` when the page is hidden (docs/04 § 1,
  `packages/tracker/src/exit.ts`). Every visit used to lose the interval
  between its last heartbeat and its exit — uniform on [0, 15 s), so **7.5 s
  per visit on average**, which is a quarter of a 30-second read. The prompting
  observation was a live one: a ~30 s read of an article on oberbrunner.com
  reported 14 s.
  - Expect `engaged_ms` up by roughly 7.5 s × visits, `engaged_sessions` up as
    short visits cross the threshold, and therefore **bounce rate down** — on
    top of the downward divergence from Matomo already described above. Short
    visits move proportionally most; a three-minute read moves ~4 %.
  - Not an accounting change: the sessionizer is untouched and still clamps
    every gap at `PING_CLAMP_MS`. What changed is that the tail now arrives.
- **2026-07-30 — schema v4**: `ix_events_site_date (site_id, local_date, type)`
  was replaced by `ix_events_site_date_visitor (…, visitor_id)`, which covers
  the distinct-visitor count whole. No metric changes; the all-sites 90-day
  dashboard batch drops from ~279 ms to ~208 ms on the bench corpus and the
  database grows ~10 B/event (287 → 297).
  - **Rollback is no longer one command.** `migrate` refuses a database newer
    than the build knows, so the pre-v4 image will not start against a v4 file.
    Rolling back means restoring the pre-deploy database copy, or dropping the
    new index, re-creating the old one and setting `PRAGMA user_version = 3` by
    hand. Take the copy before deploying.
- **2026-07-30 — one navigation is one page view, and a repeated page is one
  journey step.** Two changes, one finding, and a **deliberate divergence from
  Matomo**, which records both hits of a double-fire.
  - What was measured on the live database: SPA integrations fire
    `trackPageView` twice for a single navigation. Gaps of **0–112 ms** — not
    reloads. **pelorus-nav 4 duplicates in 21 page views (19 %)**, **globe-viz 1
    in 70 (1.4 %)**, **oberbrunner.com 0 in 67**, everything else 0 in 35. Only
    the SPAs; the static blog is clean. Affected sites: **pelorus-nav.com** and
    **globe-viz** (both native-tracker SPAs; any future SPA on the matomo.js
    shim is covered too).
  - **Tracker side** (`packages/tracker`, both the matomo.js shim and the native
    ESM tracker): a `trackPageView` for the **same URL within 1 s** of the
    previous one is dropped client-side. The window is short on purpose — a
    genuine reload is a real second view — and bounded on purpose: it sits three
    orders of magnitude below `SESSION_TIMEOUT_MS`, so it can never swallow the
    page view that legitimately *starts* the next visit and leave that visit
    with nothing in it. The owner's ruling: *"Two page-views for the same URL
    from the same origin are clearly not worth counting as two views. I don't
    think reloads are significant in any real way."* Invariant 4 is untouched:
    this is the client declining to send, never the collector declining to
    accept.
  - **Reconciliation:** on an SPA, featherstat will read **below Matomo on page
    views by that site's double-fire rate** — about 19 % on pelorus-nav, 1.4 %
    on globe-viz, 0 % everywhere else. Matomo counts both hits. Do not chase it.
    Two knock-on effects on the same sites: **bounce rate rises** (a
    single-page visit whose view double-fired had 2 page views and was not a
    bounce; now it is), and **views-per-visit falls**.
  - **Journeys side** (`query/sequences.ts`): consecutive identical step labels
    now collapse into one step, in both `transitions` and `flows`. A flow
    diagram is about movement *between* pages, so `/app → /app → /app` is one
    step, whether the repeat came from a double-fire, a reload, or an outlink
    taken from the page it labels. Sankey edges from a node to itself no longer
    exist. This changes what the sequence queries return for **every** site, not
    just the SPAs — reloads happen everywhere.
  - On the replay corpus, before → after, whole 90 days: journey steps
    **32 864 → 28 942 (−11.9 %)**, and 3 070 of 13 799 visits lose at least one
    step. Sankey edges per site (weight in brackets): site 1 **466 → 415**
    [3 662 → 3 139], site 2 **616 → 572** [6 129 → 5 352], site 3 **252 → 223**
    [2 322 → 1 821], site 4 **328 → 296** [2 570 → 2 129], site 5 **257 → 199**
    [2 124 → 1 356], site 6 **221 → 194** [1 333 → 1 066]. Distinct flow
    signatures at depth 4: **968 → 813**, **1 586 → 1 356**, **493 → 387**,
    **662 → 539**, **422 → 319**, **363 → 281**. Sessions counted as exiting
    inside a 4-step signature rise (fewer steps means more journeys finish
    inside the window): **2 464 → 2 592**, **4 111 → 4 315**, **1 548 → 1 664**,
    **1 759 → 1 857**, **1 120 → 1 286**, **1 053 → 1 109**.
  - The corpus itself gained the double-fire so the collapse is tested against
    it (invariant 6: it only gains cases). Sites 3 and 5 now repeat a share of
    their page views 0–119 ms later, at the prevalence production measured; the
    repeats draw from a second PRNG stream, so **every other hit in the corpus
    is bit-identical** and visits (13 799), visitors (12 787) and dropped/revived
    heartbeats do not move at all. What does move: stored rows **137 743 →
    138 371 (+628)**, page views **29 517 → 30 145 (+2.13 %)** — all of it site
    3 **3 845 → 3 899 (+1.40 %)** and site 5 **2 930 → 3 504 (+19.59 %)**, which
    reproduces the production rate — and bounces **2 180 → 2 134 (−46)**, site 3
    277 → 272 and site 5 227 → 186, which is the bounce distortion above, seen
    from the corpus side. Journey steps after the collapse are **28 942 either
    way**: the collapse absorbs the double-fire exactly.
  - Read cost, since the collapse needs to know what follows each row: the
    gated shapes move **85.1 → 87.1 ms** (`journeys @ 90d, busiest site`,
    budget 100) and **266 → 274 ms** (`journeys @ 90d, all sites`, budget 760).
    The naive shape — collapse into its own CTE, then number the survivors —
    cost 111 ms and breached; both kinds instead select the runs out of a single
    `LEAD` pass, and flows cuts a signature to depth only for the journeys
    actually longer than it.

## Cutover sequence

1. Deploy the new container on the GCE host (Traefik labels, new internal
   hostname), run the importer, eyeball dashboards against Matomo.
2. Enable tee mode (note the date) and repoint `analytics.example.com` to
   the new server. Bake for 1–2 weeks; compare daily numbers.
3. Cut over: **no top-up import** — see "History was dropped" below. Disable
   tee and stop the Matomo + MariaDB containers (compose entries commented,
   data kept — same reversible pattern used when Umami was retired).
   **Done 2026-08-05**: swap fell from 1006 MB to 178 MB, which was the point.
4. After a quiet month: `mysqldump` archived off-host, containers removed,
   `matomo.example.com` router alias retired, MariaDB's ~190 MB of swap
   reclaimed. **Still pending** — the containers are stopped-not-removed and
   `./matomo` still holds 222 MB of database and 246 MB of html.

## Post-cutover deltas to expect

- Bounce/engagement improve in honesty: heartbeat-based engagement replaces
  Matomo's "0 s unless a second action happened", and **bounce rate will read
  meaningfully lower than Matomo's** because engaged single-page sessions
  (dwell past the threshold, or any event) no longer count as bounces —
  that's the corrected definition (03), not an accounting error.
- **Average times will read lower too, for the mirror-image reason.** Matomo's
  "visit duration" is a *span* (last action − first action): read 2 min,
  background the tab 20, return for 2 → a "24-minute visit". Our `engaged_ms`
  is *accrued active time* (inter-ping gaps clamped at 20 s), so the same
  visit reads ~4 min. Both metrics get more truthful at cutover; neither delta
  is a regression. Note that this is *one* visit for us and, past the 30-minute
  timeout, two for Matomo — see the heartbeat entry above.
- Bot filtering differs (isbot list vs Matomo's): totals may dip a few
  percent. The diagnostics counter makes the delta visible instead of
  mysterious.
- Realtime becomes push (SSE) instead of Matomo's polling widget.
