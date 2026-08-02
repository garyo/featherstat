<script lang="ts">
import type { Filter, RealtimeEngagement, RealtimeHit } from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import { createQueryClient } from '../lib/api.ts';
import type { AuthState } from '../lib/auth.svelte.ts';
import Header from '../lib/components/Header.svelte';
import { createDashboardStore } from '../lib/dashboards.svelte.ts';
import { createLiveStream } from '../lib/live.ts';
import { pushFeed, seedFeed } from '../lib/realtime.ts';
import { createSiteDirectory } from '../lib/sites.svelte.ts';
import { createViewState } from '../lib/state.svelte.ts';
import {
  type CompareChoice,
  type DashRef,
  resolveNav,
  type SiteScope,
  type ViewName,
  type ViewRange,
} from '../lib/state.ts';
import { toggleTheme } from '../lib/theme.ts';
import type { AppEnv } from '../widgets/types.ts';
import AllSitesView from './AllSitesView.svelte';
import JourneysView from './JourneysView.svelte';
import RealtimeView from './RealtimeView.svelte';
import SiteView from './SiteView.svelte';

/**
 * The authenticated app (previously the whole of App.svelte): view state, the
 * one SSE stream, the one query client, the site directory, and the header.
 * Mounted only in the `ready` auth phase, so its connections carry a session;
 * unmounting on logout closes them.
 */
interface Props {
  admin: AdminClient;
  auth: AuthState;
}

let { admin, auth }: Props = $props();

/** Until a site card has been visited, the site switcher opens site 1. */
const FIRST_SITE = 1;

const view = createViewState();

/** Any 401 mid-session flips the app back to the login view (docs/02). */
const guardedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) auth.unauthorized();
  return response;
};

/** One query client (shared ETag cache), one SSE stream, one site directory. */
const client = createQueryClient({ fetch: guardedFetch });
const live = createLiveStream();
const directory = createSiteDirectory(guardedFetch);
/**
 * ONE dashboard store, owned here rather than by the dashboard views: the
 * header's library switcher and the view under it must read the same list and
 * the same selection, or the picker could wear a dashboard the page is not
 * showing (docs/05 § The dashboard library).
 */
// svelte-ignore state_referenced_locally
const dashboards = createDashboardStore(admin);

// Logout unmounts this shell — the stream and history listener go with it.
$effect(() => () => {
  live.close();
  view.destroy();
});

// Held at the app level so the counts (and the realtime feed) are already warm
// when a view mounts — the SSE snapshot fires once per connection, not per view.
let active = $state<Record<number, number>>({});
/**
 * The dashboards' clock. Windows like `today` are bounded by the hour in
 * progress, so without a tick a chart stops growing the moment the data does —
 * and a page left open overnight keeps yesterday (docs/05 R22). One minute is
 * finer than the smallest bucket, so nothing visibly lags.
 */
let now = $state(Date.now());
$effect(() => {
  const clock = setInterval(() => {
    now = Date.now();
  }, 60_000);
  return () => clearInterval(clock);
});

let recent = $state<RealtimeHit[]>([]);
/** Per-visitor engaged time: server-side, since only it sees the heartbeat pings. */
let visitorTimes = $state<RealtimeEngagement[]>([]);
live.on('snapshot', (snapshot) => {
  active = snapshot.active;
  recent = seedFeed(snapshot.recent, 'all');
  visitorTimes = snapshot.visitors;
});
live.on('active', (payload) => {
  active = payload.active;
  visitorTimes = payload.visitors;
});
live.on('hit', (hit) => {
  recent = pushFeed(recent, hit);
  // Optimistic active-now (docs/05 R22): the hero must never read 0 while the
  // feed shows fresh hits. The 10s `active` recount reconciles the real
  // distinct-visitor number — hits carry no visitor id (invariant 3).
  active = { ...active, [hit.siteId]: (active[hit.siteId] ?? 0) + 1 };
});

// Stream health, so a dashboard left open can never look live while it isn't.
let connected = $state(true);
live.on('status', (status) => {
  connected = status.connected;
});

const site = $derived(view.current.site);
const current = $derived(view.current.view);

// The dashboard views hold their batch until the library lookup answers, so
// the (scope, dash) load belongs to the same owner as the switcher. `dashRef`
// is a derived so a range or filter change — which replaces the whole view
// state — does not re-run the library lookup: only (site, dash) moves it.
const dashRef = $derived(view.current.dash);
$effect(() => {
  if (current === 'dash') dashboards.load(site, dashRef);
});

// Library management is a code-split chunk (docs/05 § What editability costs),
// loaded on the switcher's "Manage dashboards…" line.
let Manage = $state<typeof import('../editor/manage.ts').Manage | undefined>(undefined);
let managing = $state(false);
async function openManage(): Promise<void> {
  Manage = (await import('../editor/manage.ts')).Manage;
  managing = true;
}

// Settings (sites CRUD, snippet, password, notifications, diagnostics) is a
// code-split chunk: nobody reaches a dashboard through it, so it stays off the
// path every session opens on.
let SettingsPanel = $state<typeof import('./SettingsView.svelte').default | undefined>(undefined);
$effect(() => {
  if (current === 'settings' && SettingsPanel === undefined) {
    void import('./SettingsView.svelte').then((chunk) => {
      SettingsPanel = chunk.default;
    });
  }
});

// Which site the switcher points at: the one being viewed, or the last one
// visited while the overview is up — including after a back/forward move.
let siteTab = $state(typeof view.current.site === 'number' ? view.current.site : FIRST_SITE);
$effect(() => {
  if (typeof site === 'number') siteTab = site;
});
// Deep links can still say ?view=journeys&site=all — snap the scope to the
// fallback site once, so the picker never wears a scope the page ignores.
$effect(() => {
  if (view.current.view === 'journeys' && view.current.site === 'all') {
    view.update({ site: siteTab });
  }
});

// Site names everywhere — including the tab bar of the browser.
$effect(() => {
  const place =
    current === 'realtime'
      ? 'Realtime'
      : current === 'settings'
        ? 'Settings'
        : current === 'journeys'
          ? 'Journeys'
          : site === 'all'
            ? 'All sites'
            : directory.nameOf(site);
  document.title = `${place} · featherstat`;
});

/** Opening a scope always lands on its dashboard — one history entry. */
const selectSite = (next: SiteScope): void =>
  view.update(resolveNav(view.current, { site: next }, siteTab));
/** Journeys is per-site (docs/05): entered from the overview, it opens on the
 * switcher's last-visited site so the URL stays honest. */
const selectView = (next: ViewName): void =>
  view.update(resolveNav(view.current, { view: next }, siteTab));
const selectRange = (range: ViewRange): void => view.update({ range });
const selectCompare = (cmp: CompareChoice): void => view.update({ cmp });
const selectDash = (dash: DashRef | undefined): void => view.update({ dash });
const setFilters = (filters: Filter[]): void => view.update({ filters });
const logout = (): void => {
  void auth.logout();
};

/**
 * What this app can offer any widget on any page (widgets/types.ts): the one
 * stream, the one directory, the one clock, and the navigation only a session
 * can perform. Assembled ONCE — as separate props, every view remembered a
 * different subset, which is how a site dashboard came to show the live feed
 * beside an `active-now` hero stuck at 0.
 */
const app = $derived<AppEnv>({
  now,
  realtime: { active, recent, visitorTimes },
  // Null until the directory answers, so a card can tell "loading" from "none".
  sites: directory.sites === undefined ? null : directory.byId,
  onopenrealtime: () => selectView('realtime'),
  onselectsite: selectSite,
});
</script>

<main class="shell">
  <Header
    {site}
    view={current}
    sites={directory.sites}
    library={dashboards.library}
    dash={dashboards.selection?.ref}
    {connected}
    onselect={selectSite}
    onselectview={selectView}
    onselectdash={selectDash}
    onmanage={() => void openManage()}
    ontoggletheme={toggleTheme}
    onlogout={logout}
  />

  {#if current === 'settings'}
    {#if SettingsPanel !== undefined}
      <SettingsPanel
        {admin}
        sites={directory.sites}
        onsiteschanged={() => void directory.reload()}
      />
    {/if}
  {:else if current === 'realtime'}
    <RealtimeView {app} {site} />
  {:else if current === 'journeys'}
    <!-- A hand-edited ?view=journeys&site=all falls back to the switcher's site. -->
    {@const journeysSite = typeof site === 'number' ? site : siteTab}
    <JourneysView
      {client}
      {live}
      site={journeysSite}
      timezone={directory.byId.get(journeysSite)?.timezone}
      range={view.current.range}
      {now}
      filters={view.current.filters}
      onselectrange={selectRange}
      onfilters={setFilters}
    />
  {:else if site === 'all'}
    <AllSitesView
      {admin}
      {client}
      {live}
      {app}
      store={dashboards}
      range={view.current.range}
      cmp={view.current.cmp}
      onselectrange={selectRange}
      onselectcmp={selectCompare}
      onselectdash={selectDash}
    />
  {:else}
    <SiteView
      {admin}
      {client}
      {live}
      {app}
      store={dashboards}
      {site}
      timezone={directory.byId.get(site)?.timezone}
      range={view.current.range}
      cmp={view.current.cmp}
      filters={view.current.filters}
      onselectrange={selectRange}
      onselectcmp={selectCompare}
      onselectdash={selectDash}
      onfilters={setFilters}
    />
  {/if}

  {#if managing && Manage !== undefined}
    <Manage
      {admin}
      scope={site}
      library={dashboards.library}
      dash={view.current.dash}
      onchanged={() => dashboards.refresh()}
      onselectdash={selectDash}
      onclose={() => (managing = false)}
    />
  {/if}
</main>
