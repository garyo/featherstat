<script lang="ts">
import {
  type FilterNode,
  filterSegmentRefs,
  type RealtimeEngagement,
  type RealtimeHit,
  type SegmentFilterNode,
} from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import { adminObjects } from '../lib/admin-objects.ts';
import { createQueryClient } from '../lib/api.ts';
import type { AuthState } from '../lib/auth.svelte.ts';
import { loadChunk, onChunkFailure } from '../lib/chunks.ts';
import Header from '../lib/components/Header.svelte';
import StaleBuild from '../lib/components/StaleBuild.svelte';
import { createDashboardStore } from '../lib/dashboards.svelte.ts';
import { confirmDashboardSwitch, createEditorMode } from '../lib/editor-mode.svelte.ts';
import { createLiveStream } from '../lib/live.ts';
import { pushFeed, seedFeed } from '../lib/realtime.ts';
import { createSegmentDirectory } from '../lib/segments.svelte.ts';
import { createSiteDirectory } from '../lib/sites.svelte.ts';
import { createViewState } from '../lib/state.svelte.ts';
import {
  type CompareChoice,
  type DashRef,
  DEFAULT_VIEW_STATE,
  type DetailRef,
  discardsDraft,
  type PivotChoice,
  resolveNav,
  type SiteScope,
  type ViewName,
  type ViewRange,
  type ViewStatePatch,
} from '../lib/state.ts';
import { toggleTheme } from '../lib/theme.ts';
import type { AppEnv, RealtimeEnv } from '../widgets/types.ts';
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

/** Until a site card has been visited, the switcher opens the first readable
 * site — a scoped user's directory may not contain site 1 at all. */
const firstSite = (): number => directory.sites?.[0]?.id ?? 1;

// Back/forward is a navigation like any other: it may not take a changed draft
// away without asking (the refused move is undone — see state.svelte.ts).
const view = createViewState(window, (from, to) => !discardsDraft(from, to) || guardEdit());

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
/** Saved segments, for the filter editor's picker and for naming a segment chip. */
const segmentDir = createSegmentDirectory(guardedFetch);
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

// Edit mode is owned HERE, beside the store and the switcher that must respect
// it: the header could otherwise change ?dash= (or the scope, which clears the
// dash) under an open draft. The editor chunk itself still loads on entry.
// svelte-ignore state_referenced_locally
const mode = createEditorMode(dashboards, () => site);
// Leaving the dashboard view discards the draft — `navigate` has already asked.
$effect(() => {
  if (current !== 'dash') mode.close();
});

/** Asks before a move would discard a changed draft; a yes closes the editor. */
function guardEdit(): boolean {
  const ok = confirmDashboardSwitch(mode.dirty, dashboards.selection?.name, (message) =>
    window.confirm(message),
  );
  if (ok && mode.editing) mode.close();
  return ok;
}

/**
 * Every navigation — the header's, a widget's jump, a drill — goes through
 * here, so none can discard a draft without the same question. (The header's
 * pickers also ask first, to snap a vetoed select back; by then the editor is
 * closed and this passes.)
 */
function navigate(patch: ViewStatePatch): void {
  if (discardsDraft(view.current, { ...view.current, ...patch }) && !guardEdit()) return;
  view.update(patch);
}

// A changed draft also survives an accidental reload or tab close.
$effect(() => {
  if (!mode.dirty) return;
  const hold = (event: BeforeUnloadEvent): void => event.preventDefault();
  window.addEventListener('beforeunload', hold);
  return () => window.removeEventListener('beforeunload', hold);
});

// The dashboard views hold their batch until the library lookup answers, so
// the (scope, dash) load belongs to the same owner as the switcher. `dashRef`
// is a derived so a range or filter change — which replaces the whole view
// state — does not re-run the library lookup: only (site, dash) moves it.
const dashRef = $derived(view.current.dash);
$effect(() => {
  if (current === 'dash') dashboards.load(site, dashRef);
});

// A tab open across a deploy asks for chunk hashes the server has dropped, and
// every lazy part of the app below is then dead (lib/chunks.ts). Latched: the
// build this page is running is gone, so nothing here can un-break it.
let staleBuild = $state(false);
onChunkFailure(() => {
  staleBuild = true;
});

// Library management is a code-split chunk (docs/05 § What editability costs),
// loaded on the switcher's "Manage dashboards…" line.
let Manage = $state<typeof import('../editor/manage.ts').Manage | undefined>(undefined);
let managing = $state(false);
async function openManage(): Promise<void> {
  Manage = (await loadChunk(() => import('../editor/manage.ts')))?.Manage;
  if (Manage !== undefined) managing = true;
}

// Settings (sites CRUD, snippet, password, notifications, diagnostics) is a
// code-split chunk: nobody reaches a dashboard through it, so it stays off the
// path every session opens on.
let SettingsPanel = $state<typeof import('./SettingsView.svelte').default | undefined>(undefined);
$effect(() => {
  if (current === 'settings' && SettingsPanel === undefined) {
    void loadChunk(() => import('./SettingsView.svelte')).then((chunk) => {
      SettingsPanel = chunk?.default;
    });
  }
});

// The detail views (docs/05 § Detail views) split the same way — the entity
// templates and the view around them load on the first drill, not on boot.
let DetailPanel = $state<typeof import('./DetailView.svelte').default | undefined>(undefined);
$effect(() => {
  if (current === 'detail' && DetailPanel === undefined) {
    void loadChunk(() => import('./DetailView.svelte')).then((chunk) => {
      DetailPanel = chunk?.default;
    });
  }
});

// The filter expression editor (docs/05 § Filters) — one mount for every view
// that carries chips, code-split because a session that never filters never
// pays for it.
let FilterEditor = $state<
  typeof import('../lib/components/FilterEditor.svelte').default | undefined
>(undefined);
let filtersOpen = $state(false);
async function openFilters(): Promise<void> {
  FilterEditor ??= (await loadChunk(() => import('../lib/components/FilterEditor.svelte')))
    ?.default;
  if (FilterEditor !== undefined) filtersOpen = true;
}

/**
 * Naming an expression stores it as a segment. Offered to everyone and refused
 * by the server for a principal who may not write one — the same posture the ⚙
 * Settings tab already takes, rather than a second source of truth for the role.
 */
async function saveSegment(
  name: string,
  filters: readonly FilterNode[],
): Promise<string | undefined> {
  const first = filters[0];
  if (first === undefined) return 'nothing to save';
  try {
    await adminObjects(admin).createSegment({
      name,
      // A stored segment holds ONE tree and may not reference a segment
      // (docs/04 § 3); the request's implicit AND becomes an explicit one.
      filter: segmentFilterOf(filters.length === 1 ? first : { all: [...filters] }),
    });
    await segmentDir.reload();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'could not save the segment';
  }
}

/** Refuses a segment ref rather than storing a tree the server would reject. */
function segmentFilterOf(node: FilterNode): SegmentFilterNode {
  if (filterSegmentRefs(node).length > 0) {
    throw new Error('a saved segment cannot reference another segment');
  }
  return node as SegmentFilterNode;
}

// Which site the switcher points at: the one being viewed, or the last one
// visited while the overview is up — including after a back/forward move.
let siteTab = $state(typeof view.current.site === 'number' ? view.current.site : 1);
// The directory arrives after boot: adopt the first readable site while no
// explicit choice has been made, so a scoped user never wears a site they
// cannot read as their fallback.
$effect(() => {
  if (typeof view.current.site !== 'number' && directory.sites !== undefined) {
    const readable = directory.sites.some((s) => s.id === siteTab);
    if (!readable) siteTab = firstSite();
  }
});
$effect(() => {
  if (typeof site === 'number') siteTab = site;
});
// Deep links can still say ?view=journeys&site=all (or a detail view at all) —
// snap the scope to the fallback site once, so the picker never wears a scope
// the page ignores.
$effect(() => {
  if (
    (view.current.view === 'journeys' || view.current.view === 'detail') &&
    view.current.site === 'all'
  ) {
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
          : current === 'detail'
            ? (view.current.detail?.value ?? 'Detail')
            : site === 'all'
              ? 'All sites'
              : directory.nameOf(site);
  document.title = `${place} · featherstat`;
});

/** Opening a scope always lands on its dashboard — one history entry. */
const selectSite = (next: SiteScope): void =>
  navigate(resolveNav(view.current, { site: next }, siteTab));
/** Journeys is per-site (docs/05): entered from the overview, it opens on the
 * switcher's last-visited site so the URL stays honest. */
const selectView = (next: ViewName): void =>
  navigate(resolveNav(view.current, { view: next }, siteTab));
const selectRange = (range: ViewRange): void => navigate({ range });
const selectCompare = (cmp: CompareChoice): void => navigate({ cmp });
const selectDash = (dash: DashRef | undefined): void =>
  navigate(resolveNav(view.current, { dash }, siteTab));
/** The wordmark: every axis back to its default, which serializes to a bare `/`. */
const selectHome = (): void => navigate(DEFAULT_VIEW_STATE);
const setFilters = (filters: FilterNode[]): void => navigate({ filters });
const setPivots = (pivots: PivotChoice[]): void => navigate({ pivots });
/** A drill is a history push — back returns to the dashboard that was left. */
const openDetail = (detail: DetailRef): void =>
  navigate(resolveNav(view.current, { detail }, siteTab));
const logout = (): void => {
  if (guardEdit()) void auth.logout();
};

/**
 * What this app can offer any widget on any page (widgets/types.ts): the one
 * stream, the one directory, the one clock, and the navigation only a session
 * can perform. Assembled ONCE — as separate props, every view remembered a
 * different subset, which is how a site dashboard came to show the live feed
 * beside an `active-now` hero stuck at 0.
 *
 * One stable object of getters, never a fresh value: a hit lands several
 * times a second on a busy site, and only the widgets that read the stream (or
 * the clock) may re-derive for it — not every card on the page (widgets/env.ts
 * `extendEnv` carries the getters through).
 */
const realtime: RealtimeEnv = {
  get active() {
    return active;
  },
  get recent() {
    return recent;
  },
  get visitorTimes() {
    return visitorTimes;
  },
};
const app: AppEnv = {
  get now() {
    return now;
  },
  realtime,
  // Null until the directory answers, so a card can tell "loading" from "none".
  get sites() {
    return directory.sites === undefined ? null : directory.byId;
  },
  onopenrealtime: () => selectView('realtime'),
  onselectsite: selectSite,
};
</script>

<main class="shell">
  <Header
    {site}
    view={current}
    sites={directory.sites}
    library={dashboards.library}
    dash={dashboards.selection?.ref}
    {connected}
    guard={guardEdit}
    onselect={selectSite}
    onselectview={selectView}
    onselectdash={selectDash}
    onmanage={() => void openManage()}
    onhome={selectHome}
    ontoggletheme={toggleTheme}
    onlogout={logout}
    showSettings={auth.role !== 'viewer'}
    who={auth.email}
  />

  {#if current === 'settings'}
    {#if SettingsPanel !== undefined}
      <SettingsPanel
        {admin}
        sites={directory.sites}
        role={auth.role}
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
      segmentNames={segmentDir.names}
      onselectrange={selectRange}
      onfilters={setFilters}
      oneditfilters={() => void openFilters()}
    />
  {:else if current === 'detail'}
    {@const detailSite = typeof site === 'number' ? site : siteTab}
    {#if DetailPanel !== undefined && view.current.detail !== undefined}
      <DetailPanel
        {app}
        {client}
        {live}
        site={detailSite}
        timezone={directory.byId.get(detailSite)?.timezone}
        detail={view.current.detail}
        range={view.current.range}
        cmp={view.current.cmp}
        filters={view.current.filters}
        segmentNames={segmentDir.names}
        onselectrange={selectRange}
        onselectcmp={selectCompare}
        onfilters={setFilters}
        oneditfilters={() => void openFilters()}
        onopendetail={openDetail}
      />
    {/if}
  {:else if site === 'all'}
    <AllSitesView
      {admin}
      {client}
      {live}
      {app}
      store={dashboards}
      {mode}
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
      {mode}
      {site}
      timezone={directory.byId.get(site)?.timezone}
      range={view.current.range}
      cmp={view.current.cmp}
      filters={view.current.filters}
      segmentNames={segmentDir.names}
      pivots={view.current.pivots}
      onselectrange={selectRange}
      onselectcmp={selectCompare}
      onselectdash={selectDash}
      onfilters={setFilters}
      oneditfilters={() => void openFilters()}
      onpivots={setPivots}
      onopendetail={openDetail}
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

  {#if filtersOpen && FilterEditor !== undefined}
    <FilterEditor
      filters={view.current.filters}
      segments={segmentDir.segments}
      onsavesegment={saveSegment}
      onapply={(filters) => {
        setFilters(filters);
        filtersOpen = false;
      }}
      onclose={() => (filtersOpen = false)}
    />
  {/if}

  <!-- Last, and above everything: a chunk that will not load is the one thing on
       screen the page cannot resolve for itself. -->
  {#if staleBuild}
    <StaleBuild />
  {/if}
</main>
