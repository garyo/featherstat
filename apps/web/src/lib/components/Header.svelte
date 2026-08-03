<script lang="ts">
import type { SiteInfo } from '@featherstat/shared';
import type { LibraryEntry } from '../dashboards.ts';
import { type DashRef, parseDashRef, type SiteScope, type ViewName } from '../state.ts';

interface Props {
  /** The scope currently shown — `all` selects the overview tab. */
  site: SiteScope;
  view: ViewName;
  /** The real site directory (`/api/sites`); undefined while it loads. */
  sites: SiteInfo[] | undefined;
  /** The scope's dashboard library (docs/05 § The dashboard library); the
   * switcher renders only on the Dashboard view and only once this is non-empty. */
  library?: readonly LibraryEntry[];
  /** The library entry actually on screen (resolved, so a default wears its name). */
  dash?: DashRef;
  /** SSE health — false shows the "reconnecting" note (docs/05 R22: never silently stale). */
  connected?: boolean;
  /** Asked before a scope/dashboard pick lands — false vetoes it (an open
   * editor draft confirms the discard); the select snaps back to what is on screen. */
  guard?: () => boolean;
  /** Opens the dashboard for a scope — one state update (site + view together). */
  onselect: (site: SiteScope) => void;
  onselectview: (view: ViewName) => void;
  onselectdash?: (dash: DashRef) => void;
  /** Opens the library management panel (a code-split chunk). */
  onmanage?: () => void;
  /** The wordmark: back to the default view state, which is the bare `/` URL. */
  onhome: () => void;
  ontoggletheme: () => void;
  onlogout: () => void;
}

let {
  site,
  view,
  sites,
  library = [],
  dash,
  connected = true,
  guard = () => true,
  onselect,
  onselectview,
  onselectdash,
  onmanage,
  onhome,
  ontoggletheme,
  onlogout,
}: Props = $props();

const selected = $derived(site === 'all' ? 'all' : String(site));

function onchange(event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  if (!guard()) {
    select.value = selected;
    return;
  }
  const raw = select.value;
  if (raw === 'all') {
    onselect('all');
    return;
  }
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) onselect(id);
}

function ondashchange(event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  if (select.value === '~manage') {
    // A command, not a selection: restore the picker to what is on screen.
    select.value = String(dash ?? '');
    onmanage?.();
    return;
  }
  if (!guard()) {
    select.value = String(dash ?? '');
    return;
  }
  const ref = parseDashRef(select.value);
  if (ref !== undefined) onselectdash?.(ref);
}

/** A real href, so a modified click still opens `/` in a tab; a plain one stays
 * in the app and resets the view state, and asks first like the pickers do. */
function onhomeclick(event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (guard()) onhome();
}
</script>

<header class="top">
  <a class="wordmark" href="/" onclick={onhomeclick}>
    <span class="fs-mark" role="img" aria-label="featherstat mark"></span>
    featherstat
  </a>
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
  <!-- The scope's dashboard library, same select grammar as the scope picker.
       Only on the Dashboard view: the other views render no dashboard. -->
  {#if view === 'dash' && library.length > 0 && dash !== undefined}
    <select class="tab site-switch" aria-label="Dashboard" value={String(dash)} onchange={ondashchange}>
      {#each library as entry (entry.ref)}
        <option value={String(entry.ref)}
          >{entry.name}{entry.kind === 'template' ? ' (built-in)' : ''}</option
        >
      {/each}
      {#if onmanage !== undefined}<option value="~manage">Manage dashboards…</option>{/if}
    </select>
  {/if}
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
