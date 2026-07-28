<script lang="ts">
import type { Filter, RealtimeHit } from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import { createQueryClient } from '../lib/api.ts';
import type { AuthState } from '../lib/auth.svelte.ts';
import Header from '../lib/components/Header.svelte';
import { createLiveStream } from '../lib/live.ts';
import { pushFeed, seedFeed } from '../lib/realtime.ts';
import { createSiteDirectory } from '../lib/sites.svelte.ts';
import { createViewState } from '../lib/state.svelte.ts';
import type { RangePreset, SiteScope, ViewName } from '../lib/state.ts';
import { toggleTheme } from '../lib/theme.ts';
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

// Logout unmounts this shell — the stream and history listener go with it.
$effect(() => () => {
  live.close();
  view.destroy();
});

// Held at the app level so the counts (and the realtime feed) are already warm
// when a view mounts — the SSE snapshot fires once per connection, not per view.
let active = $state<Record<number, number>>({});
let recent = $state<RealtimeHit[]>([]);
live.on('snapshot', (snapshot) => {
  active = snapshot.active;
  recent = seedFeed(snapshot.recent, 'all');
});
live.on('active', (payload) => {
  active = payload.active;
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
  document.title = `${place} · Analytics`;
});

/** Opening a scope always lands on its dashboard — one history entry. */
const selectSite = (next: SiteScope): void => view.update({ site: next, view: 'dash' });
/** Journeys is per-site (docs/05): entered from the overview, it opens on the
 * switcher's last-visited site so the URL stays honest. */
const selectView = (next: ViewName): void =>
  view.update(
    next === 'journeys' && site === 'all' ? { view: next, site: siteTab } : { view: next },
  );
const selectRange = (range: RangePreset): void => view.update({ range });
const setFilters = (filters: Filter[]): void => view.update({ filters });
const logout = (): void => {
  void auth.logout();
};
</script>

<main class="shell">
  <Header
    {site}
    view={current}
    {siteTab}
    sites={directory.sites}
    {connected}
    onselect={selectSite}
    onselectview={selectView}
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
    <RealtimeView {active} {recent} {site} />
  {:else if current === 'journeys'}
    <!-- A hand-edited ?view=journeys&site=all falls back to the switcher's site. -->
    {@const journeysSite = typeof site === 'number' ? site : siteTab}
    <JourneysView
      {client}
      {live}
      site={journeysSite}
      timezone={directory.byId.get(journeysSite)?.timezone}
      range={view.current.range}
      filters={view.current.filters}
      onselectrange={selectRange}
      onfilters={setFilters}
    />
  {:else if site === 'all'}
    <AllSitesView
      {admin}
      {client}
      {live}
      {active}
      sites={directory.sites}
      byId={directory.byId}
      onselectsite={selectSite}
    />
  {:else}
    <SiteView
      {admin}
      {client}
      {live}
      {site}
      timezone={directory.byId.get(site)?.timezone}
      range={view.current.range}
      filters={view.current.filters}
      onselectrange={selectRange}
      onfilters={setFilters}
    />
  {/if}
</main>
