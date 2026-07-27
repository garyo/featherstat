<script lang="ts">
import { createQueryClient } from './lib/api.ts';
import Header from './lib/components/Header.svelte';
import { createLiveStream } from './lib/live.ts';
import { createViewState } from './lib/state.svelte.ts';
import type { RangePreset, SiteScope } from './lib/state.ts';
import { toggleTheme } from './lib/theme.ts';
import AllSitesView from './views/AllSitesView.svelte';
import SiteView from './views/SiteView.svelte';

/** Until a site card has been visited, the site tab opens site 1. */
const FIRST_SITE = 1;

const view = createViewState();
/** One query client (shared ETag cache) and one SSE stream for the whole app. */
const client = createQueryClient();
const live = createLiveStream();

// Held at the app level so the counts are already warm when a view mounts —
// the SSE snapshot fires once per connection, not per view.
let active = $state<Record<number, number>>({});
live.on('snapshot', (snapshot) => {
  active = snapshot.active;
});
live.on('active', (payload) => {
  active = payload.active;
});

// Stream health, so a dashboard left open can never look live while it isn't.
let connected = $state(true);
live.on('status', (status) => {
  connected = status.connected;
});

const site = $derived(view.current.site);

// Which site the site tab points at: the one being viewed, or the last one
// visited while the overview is up — including after a back/forward move.
let siteTab = $state(typeof view.current.site === 'number' ? view.current.site : FIRST_SITE);
$effect(() => {
  if (typeof site === 'number') siteTab = site;
});

const selectSite = (next: SiteScope): void => view.update({ site: next });
const selectRange = (range: RangePreset): void => view.update({ range });
</script>

<main class="shell">
  <Header
    {site}
    {siteTab}
    {connected}
    siteLabel="Site {siteTab}"
    onselect={selectSite}
    ontoggletheme={toggleTheme}
  />

  {#if site === 'all'}
    <AllSitesView {client} {live} {active} onselectsite={selectSite} />
  {:else}
    <SiteView {client} {live} {site} range={view.current.range} onselectrange={selectRange} />
  {/if}
</main>
