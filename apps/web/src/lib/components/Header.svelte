<script lang="ts">
import type { SiteInfo } from '@analytics/shared';
import type { SiteScope, ViewName } from '../state.ts';

interface Props {
  /** The scope currently shown — `all` selects the overview tab. */
  site: SiteScope;
  view: ViewName;
  /** Site the switcher wears while no site view is up (the last one visited). */
  siteTab: number;
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
  siteTab,
  sites,
  connected = true,
  onselect,
  onselectview,
  ontoggletheme,
  onlogout,
}: Props = $props();

const siteActive = $derived(view === 'dash' && site !== 'all');
const nameOf = (id: number): string => sites?.find((s) => s.id === id)?.name ?? `Site ${id}`;
/**
 * While no site view is up the switcher sits on a placeholder that wears the
 * last-visited site's name — so choosing ANY site (that one included) is a
 * value change and fires. On a site view it sits on the real id.
 */
const selected = $derived(siteActive ? String(site) : '');

function onchange(event: Event): void {
  const raw = (event.currentTarget as HTMLSelectElement).value;
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) onselect(id);
}
</script>

<header class="top">
  <div class="wordmark">Analytics<span class="dot">.</span></div>
  <!-- Plain navigation, not a tablist: these change the URL, and there is no
       tabpanel for aria-controls to name. -->
  <nav class="tabs" aria-label="Views">
    <button
      class="tab"
      type="button"
      aria-current={view === 'dash' && site === 'all' ? 'page' : undefined}
      onclick={() => onselect('all')}>All sites</button
    >
    <!-- The site switcher (docs/05): the real sites from /api/sites, styled as the site tab. -->
    <select
      class="tab site-switch"
      aria-label="Site"
      aria-current={siteActive ? 'page' : undefined}
      value={selected}
      {onchange}
    >
      <!-- disabled + aria-hidden: assistive tech must not list the placeholder
           as a duplicate of the site it wears the name of. -->
      {#if !siteActive}
        <option value="" hidden disabled aria-hidden="true">{nameOf(siteTab)}</option>
      {/if}
      {#each sites ?? [] as entry (entry.id)}
        <option value={String(entry.id)}>{entry.name}</option>
      {:else}
        <option value={String(siteTab)}>{nameOf(siteTab)}</option>
      {/each}
    </select>
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
