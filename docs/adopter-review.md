# An adopter's review — and what a better package would look like

*Written 2026-08-02, from the perspective of someone managing a handful of
small-to-medium websites, evaluating featherstat against Plausible, Umami,
Matomo, and GoatCounter as a privacy-focused self-hosted analytics package.
Technical considerations only — maturity and community size deliberately
ignored. Based on a full read of the design docs, server, tracker, shared
package, and web app at HEAD `d507174`.*

---

## Part 1: Would I choose featherstat?

**TL;DR:** If my needs match its exact design point — a handful of sites, one
admin (me), cookieless privacy as a hard requirement, and especially if I'm
migrating off Matomo — featherstat is genuinely attractive, with engineering
quality well above its peers. I'd walk away if I need any of: data export, API
access from scripts, multiple users, custom event properties, funnels/goals, or
headroom past a few million events/month. Several of those are explicit
non-goals, not missing features.

### What would pull me in

**The privacy design is the most rigorous in this class, and honest about its
costs.** Cookieless always (`disableCookies` is a no-op because there's nothing
to disable). Visitor ID is `SHA-256(daily-salt ‖ site ‖ IP ‖ UA)` with the salt
rotated at *site-local* midnight and old salts destroyed — cross-day
re-identification isn't just avoided, it's cryptographically impossible. Raw IP
never touches disk, with a test proving nothing IP-shaped reaches the realtime
wire. Crucially, the product tells the truth about the consequence:
unique-visitor counts over multi-day ranges are approximate, the API *refuses*
to sum them across days, and the UI marks them with `~`. Plausible makes the
same trade and is quieter about it.

**The tracker is best-in-class lightweight.** 1.8 KB gzipped native ESM, 2.2 KB
for the Matomo-compatible shim, both under CI-enforced size budgets — and it
captures more real signal than Plausible or GoatCounter: engagement heartbeats
gated on focus *and* visibility *and* recent input, an exit ping recovering
~7.5 s of otherwise-lost attention per visit, per-pageview scroll depth done
correctly (re-measured against live document height, "unmeasured" distinguished
from 0%), SPA double-fire guards.

**The metric definitions are better than the industry's.** Bounce is
engagement-aware (a visitor who reads one page for three minutes is not a
bounce). Time-on-page is accrued attention, not timestamp span. Every
divergence from Matomo's numbers is quantified against a replay corpus in the
migration doc (visits ~4% lower, and here's exactly why). This is what I want
from analytics: numbers I can defend.

**The Matomo migration path is real, not aspirational.** A `/matomo.php`
endpoint pinned by a golden corpus of real access-log beacons, a tee mode
forwarding every hit to live Matomo during the bake so rollback is a proxy
rule, a MariaDB history importer with validation gates, and a cutover runbook
from an actual production migration. Nobody else in this space has this —
Plausible/Umami migrations mean abandoning history and tags.

**The query architecture is smarter than anything I'd compare it to.** One
batched `/api/query` per dashboard view (explicitly the anti-Matomo design —
no 30-widget request storms), executed in a single read snapshot so every
widget describes the same instant, ETags computed over data-version + resolved
time windows so an unchanged dashboard revalidates for free, and SSE push
telling the client *when* to revalidate rather than polling. Responses are
self-describing (units, populations, aggregation rules per metric) so clients
never do metric arithmetic. Per-site IANA timezones computed at ingest,
DST-correct axes — rigor most commercial tools lack.

**Code quality is a genuine differentiator.** ~656 server test cases, zero
TODO/FIXME markers in ~43k lines, invariants enforced by tests rather than
convention (one test sends `'; DELETE FROM events; --'` through the live route
and checks the table survived), SQL injection structurally impossible
(identifiers only from closed vocabularies, everything parameterized), careful
auth (deny-by-default route gate, `__Host-` cookies, scrypt, timing-safe
compares, correct X-Forwarded-For handling — which almost everyone gets wrong).
And unusual candor: the bench prints "OVER DOCS/02 BUDGET" on every run rather
than hiding a missed perf target.

**Ops footprint is exactly right for my scale.** One Node process, one SQLite
file, one container, <100 MB RSS target, runs on a 2 GB VM. Prometheus
`/metrics` and `/healthz` included.

### What would push me away

**No data gets out.** No CSV export, no data-export endpoint of any kind, no
API tokens — `/api/query` requires an admin session cookie with CSRF, has no
CORS, and is rate-limited for dashboard use, not extraction. "Export" means
dashboard *layout* JSON. If I ever want traffic numbers in a spreadsheet, a
report to a client, or a script pulling weekly stats, my only option is
querying the SQLite file directly. For someone managing sites *for other
people*, this is close to disqualifying — clients get a read-only share link
and nothing else.

**Single admin, full stop.** No users, no roles, no per-site permissions.
Multi-tenancy is an explicit non-goal. Umami and Matomo both give me team
access.

**The event model is closed.** Events are category/action/name/value — no
custom dimensions, no arbitrary property bags, anywhere in the pipeline
(tracker schema through storage through query vocabulary). No goals as
first-class objects, no funnels (Journeys' sankey is the substitute — nice, but
not a conversion funnel), no saved segments; filters are flat ANDs with no
OR/regex. The query vocabulary is elegant *and* a cage: 12 metrics × 23
dimensions, two deep, and no escape hatch.

**Analysis stops one click deep.** Click-to-filter chips are the entire
drilldown story. There's no filter builder (you can't author a filter that
isn't clickable from some row), no saved segments, no way to pivot a widget's
breakdown, no per-page or per-referrer detail views, six fixed date presets
with no custom range, and the comparison period is hard-wired to "previous."
UTM parameters are captured and breakable as dimensions, but nothing *manages*
campaigns: no normalization, no campaign registry, no link builder, no
tagged-vs-untagged hygiene view.

**Scaling has a visible ceiling and a nasty coupling.** No rollup tables —
every query scans raw rows, and better-sqlite3 is synchronous, so a 760 ms
90-day journeys query *blocks beacon ingestion for 760 ms*. The bench shows
long-range views already 10× over the stated 50 ms budget on synthetic data.
Fine at 1–2 events/sec; a real problem if a site grows.

**Operational gaps I'd have to cover myself:** zero rate limiting on the public
ingest endpoints (anyone with a site ID can write unlimited rows to my SQLite
file — I'd need a proxy-level limit), no backup beyond "it's one file" (a live
WAL-mode file at that — naïve `cp` is unsafe and the docs don't say so), no
site deletion (orphaned rows forever), retention configurable only by
hand-editing a settings row, abrupt SIGTERM handling, `console.log` logging.

**Docs are for developers, not operators.** The design docs are excellent — but
the entire operator-facing surface is one README section. No upgrade guide (and
rollback after a schema migration requires a file restore, documented only
inside a deploy log), no backup/restore procedure, no troubleshooting. Also no
GDPR positioning statement, no DNT/GPC honoring, no visitor opt-out — the
privacy story is architectural, never articulated for a compliance
conversation.

**Verdict as this persona:** for my own sites, coming from Matomo, I'd
seriously consider it over Plausible/Umami — the tracker, metric honesty, and
migration story beat both. The moment client reporting, team access, data
export, or real campaign analysis enters the picture, I'd choose Umami
(multi-user, API) or stay on Matomo (everything, at the cost of everything).

---

## Part 2: What I'd build instead

Featherstat's deepest insight is worth keeping: **most of its weaknesses are
principled trades, but a few are false trades** — you can have the other side
without giving up the simplicity.

### Keep unchanged (featherstat got these right)

- **One process, one SQLite file, one container.** The single-binary story is
  the whole reason self-hosters choose these tools.
- **Cookieless daily-salted identity with honest approximate uniques** —
  including the API refusing to fabricate a summable "monthly uniques."
- **The batched-query + ETag + SSE-invalidation architecture.** The best query
  design in the space; copy it outright.
- **Engagement-aware metric definitions**, quantified against a replay corpus.
- **The tiny tracker with real signal** (idle-gated attention, exit pings,
  scroll depth).
- **Self-describing responses and per-site timezone rigor.**
- **The engineering culture**: golden corpora, ratchets, invariants enforced by
  tests.

### Fix the false trades

**1. Data must get out.** Scoped API tokens (read-only, per-site) as a
first-class object from day one; the *same* query vocabulary served over token
auth with CORS; `?format=csv` on every query result; and a documented "the
SQLite file is yours" schema contract so `sqlite3`/`datasette` access is a
supported interface, not a workaround. None of this compromises privacy — it's
the operator's own data.

**2. Async reads.** Keep synchronous better-sqlite3 for the single writer (its
transaction discipline is lovely), but run queries in a small worker-thread
pool with read-only connections. WAL already permits concurrent readers; this
one change decouples dashboard latency from beacon ingestion and removes the
scariest coupling for maybe 200 lines of code.

**3. Rollups from day one, behind the same vocabulary.** Featherstat explicitly
designed the query vocabulary so rollups could slot in later — so slot them in
now: an hourly aggregate table maintained in the same 200 ms flush transaction,
with the compiler routing to rollups when no raw-row-only dimension is
requested. 90-day views become O(hours) instead of O(events); the traffic
ceiling rises ~100× without touching the API. Ratchet: a test that rollups and
raw scans answer identically on the golden corpus.

**4. One property bag, resisted everywhere else.** Full custom-dimension
systems are how Matomo got fat, but *zero* extensibility is too far the other
way. Compromise: events carry an optional `props` JSON object (validated,
size-capped, keys per site capped at ~30 to bound cardinality), queryable as
one additional dimension (`prop:plan`). Goals become trivially expressible as
*saved queries with a target* — a name, a filter, an optional value — rather
than a new subsystem. ~80% of Matomo's goals/segments value for ~5% of its
complexity.

**5. Lightweight multi-reader auth.** Not RBAC. Three levels: one admin,
invited *viewers* scoped to sites (email + magic link, no password
infrastructure), and share links. This covers "my client wants to see their
stats" — the single most common need featherstat can't meet — while staying
miles from multi-tenant SaaS.

**6. Ops as product.** Nightly `VACUUM INTO` backup to a configurable path with
retention (SQLite makes safe online backup nearly free — no excuse to omit it);
site deletion that actually deletes rows; retention settings in the admin UI;
structured JSON logs; a drained shutdown. Plus a written privacy posture: honor
GPC, ship a template "no consent banner needed because…" statement, document
the DSAR argument (no cross-day identity exists to disclose or delete).

**7. Operator docs as a deliverable.** Install, upgrade (including "copy the DB
before deploying; here's the rollback"), backup/restore, tuning, and a
compliance page. Featherstat proves great design docs don't substitute.

### The analyst's axis — from *viewing* numbers to *answering* questions

The section above fixes operational trades. This one addresses a different
critique: featherstat is a beautifully engineered *viewer* of a fixed set of
answers. The bigger opportunity is the analyst loop — see something, ask why,
drill in, act. Everything here builds on machinery featherstat already has;
almost none of it requires new storage.

**8. Drilldowns as first-class navigation.** Today a click adds a filter chip
and the same dashboard re-renders. The natural next question — "tell me about
*this page*" — deserves its own answer: click any row and get a detail view for
that entity. A page detail shows its trend, referrers *to it*, next pages
*from it*, scroll-depth and dwell distributions, entry/exit rates. A referrer
detail shows which landing pages it feeds and how engaged its traffic is.
These are just pre-composed batches over the existing vocabulary — the
transitions/dwell machinery already computes the hard parts. The widget system
makes them cheap: a detail view is a dashboard template parameterized by one
filter. This single feature converts the tool from reporting to analysis.

**9. A real filter/segment layer.** A filter builder (any dimension × any op,
OR groups, negation, regex on path) instead of only click-derived chips; saved
segments as named filter sets applied with one click and usable in
comparisons ("organic search vs. social, side by side"). The compiler already
refuses dishonest combinations per-query — extend that honesty to richer
boolean shapes rather than forbidding them. Segments are also the natural unit
for alerts and digests (below).

**10. Dashboards as a library, not a singleton.** Featherstat's widget/editor
foundation is genuinely good — JSON documents, schema-validated, batch-checked,
import/export. But one saved dashboard per scope, no naming, no duplication, no
reset-to-default wastes that foundation. Instead: multiple named dashboards per
site organized around *questions* ("Content", "Acquisition", "Campaigns",
"Site health"), shipped as templates users can clone and edit; duplicate /
rename / delete / reset; per-widget filter overrides (a "blog-only top pages"
widget beside the global one); pivotable breakdowns (swap the dimension on any
widget in place); custom date ranges and a comparison selector (previous
period / same period last year / custom). The `MetricSchema`/`DimensionSchema`
enums already drive the add-widget flow — pivoting and overrides are UI over
what exists.

**11. "What changed" — answers, not just numbers.** The most actionable report
in analytics is an automatic diff: traffic is up 18% vs. last week — *which*
pages, referrers, campaigns, and countries contributed, ranked by their share
of the change. This is a handful of two-period queries plus a contribution
sort — no new storage, enormous payoff. Pair it with: annotations on
timeseries (deploys, posts published, campaign launches — one tiny table,
rendered as markers so spikes have explanations); and threshold/anomaly alerts
plus a weekly digest that names movers, both riding the existing ntfy plumbing.
The digest's job is one sentence per site: "up because these two posts got
Hacker News traffic," not a table of totals.

**12. Campaigns as managed objects, not just stored strings.** featherstat
captures utm_*/mtm_* into columns and stops. A campaign layer on top:
normalization at ingest (lowercase, trim, an alias map so `Newsletter`,
`newsletter`, and `nl` converge); a campaign registry — named campaigns with
expected source/medium values and lifespan; a UTM link builder in the UI that
generates correctly-tagged URLs from the registry (killing taxonomy drift at
the source); a campaign report — sessions, engagement, goal completions per
campaign/source/medium against the registry; and an explicit *untagged and
misspelled* bucket, because surfacing hygiene failures is half the value of
managing campaigns at all. For a multi-site operator this is routinely the
difference between "we got traffic" and "that newsletter worked."

**13. Extensibility with a narrow waist.** Two escape hatches, both small:
*derived metrics* — named, saved expressions over existing metrics
(`events / visits`, `event_value_sum / engaged_sessions`) validated against a
tiny arithmetic grammar, so the vocabulary can grow per-install without
open-coding SQL; and a *widget contract stable enough to write against* — the
`WidgetProps {spec, env}` seam already exists and is clean; document it,
finish the placeholder `table`/`map` viz types, and make the registry the only
file a new visualization touches. Not a plugin marketplace — just a wall that's
climbable where today it's smooth.

### The shape of the result

Same silhouette as featherstat — one container, one file, tiny tracker,
batched queries, honest cookieless metrics — but with the doors it keeps shut
opened just a crack: data out (tokens + CSV), people in (scoped viewers),
meaning attached (props + saved-query goals), time survived (rollups, backups,
deletion), and — the part this review initially undervalued — *questions
answered*: drilldowns, segments, a dashboard library, "what changed," and
campaigns managed rather than merely recorded. Everything else featherstat
says "no" to — funnels-as-subsystem, e-commerce, session replay, horizontal
scaling, RBAC — stays "no," for exactly its reasons.

The meta-lesson to carry over most carefully is the one in its CLAUDE.md: *an
invariant a test enforces is documentation; one enforced only by memory is a
liability.* Every door above needs its ratchet — token scopes that can't
widen, props cardinality caps that hold, rollups that provably match raw
scans, campaign normalization pinned by fixtures. That discipline, more than
any feature, is what's actually worth copying.
