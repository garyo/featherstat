<script lang="ts">
import type { SiteInfo } from '@featherstat/shared';
import type { SiteScope, ViewName } from '../state.ts';

interface Props {
  /** The scope currently shown — `all` selects the overview tab. */
  site: SiteScope;
  view: ViewName;
  /** The real site directory (`/api/sites`); undefined while it loads. */
  sites: SiteInfo[] | undefined;
  /** SSE health — false shows the "reconnecting" note (docs/05 R22: never silently stale). */
  connected?: boolean;
  /** Opens the dashboard for a scope — one state update (site + view together). */
  onselect: (site: SiteScope) => void;
  onselectview: (view: ViewName) => void;
  ontoggletheme: () => void;
  onlogout: () => void;
}

let {
  site,
  view,
  sites,
  connected = true,
  onselect,
  onselectview,
  ontoggletheme,
  onlogout,
}: Props = $props();

const selected = $derived(site === 'all' ? 'all' : String(site));

function onchange(event: Event): void {
  const raw = (event.currentTarget as HTMLSelectElement).value;
  if (raw === 'all') {
    onselect('all');
    return;
  }
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) onselect(id);
}
</script>

<header class="top">
  <div class="wordmark">
    <span class="fs-mark" role="img" aria-label="featherstat mark"></span>
    featherstat
  </div>
  <!-- Plain navigation, not a tablist: these change the URL, and there is no
       tabpanel for aria-controls to name. -->
  <!-- Scope x View (docs/05): ONE scope picker, three view tabs. The picker's
       value is always the actual scope; the tabs carry page-currency. -->
  <select class="tab site-switch" aria-label="Scope" value={selected} {onchange}>
    <option value="all">All sites</option>
    {#each sites ?? [] as entry (entry.id)}
      <option value={String(entry.id)}>{entry.name}</option>
    {/each}
  </select>
  <nav class="tabs" aria-label="Views">
    <button
      class="tab"
      type="button"
      aria-current={view === 'dash' ? 'page' : undefined}
      onclick={() => onselectview('dash')}>Dashboard</button
    >
    <button
      class="tab"
      type="button"
      aria-current={view === 'journeys' ? 'page' : undefined}
      onclick={() => onselectview('journeys')}>Journeys</button
    >
    <button
      class="tab"
      type="button"
      aria-current={view === 'realtime' ? 'page' : undefined}
      onclick={() => onselectview('realtime')}>Realtime</button
    >
  </nav>
  <div class="spacer"></div>
  {#if !connected}<span class="compare-note">Live updates reconnecting…</span>{/if}
  <button
    class="icon-btn"
    type="button"
    title="Settings"
    aria-label="Settings"
    aria-current={view === 'settings' ? 'page' : undefined}
    onclick={() => onselectview('settings')}>⚙</button
  >
  <button
    class="icon-btn"
    type="button"
    title="Toggle light/dark"
    aria-label="Toggle light or dark theme"
    onclick={ontoggletheme}>◐</button
  >
  <button class="tab logout" type="button" onclick={onlogout}>Log out</button>
</header>
