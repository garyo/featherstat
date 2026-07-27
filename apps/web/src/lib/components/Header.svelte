<script lang="ts">
import type { SiteScope } from '../state.ts';

interface Props {
  /** The scope currently shown — `all` selects the overview tab. */
  site: SiteScope;
  /** Site the site tab opens; the label the tab wears. */
  siteTab: number;
  siteLabel: string;
  /** SSE health — false shows the "reconnecting" note (docs/05 R22: never silently stale). */
  connected?: boolean;
  onselect: (site: SiteScope) => void;
  ontoggletheme: () => void;
}

let { site, siteTab, siteLabel, connected = true, onselect, ontoggletheme }: Props = $props();
</script>

<header class="top">
  <div class="wordmark">Analytics<span class="dot">.</span></div>
  <!-- Plain navigation, not a tablist: these change the URL, and there is no
       tabpanel for aria-controls to name. -->
  <nav class="tabs" aria-label="Views">
    <button
      class="tab"
      type="button"
      aria-current={site === 'all' ? 'page' : undefined}
      onclick={() => onselect('all')}>All sites</button
    >
    <button
      class="tab"
      type="button"
      aria-current={site !== 'all' ? 'page' : undefined}
      onclick={() => onselect(siteTab)}>{siteLabel}</button
    >
  </nav>
  <div class="spacer"></div>
  {#if !connected}<span class="compare-note">Live updates reconnecting…</span>{/if}
  <button
    class="icon-btn"
    type="button"
    title="Toggle light/dark"
    aria-label="Toggle light or dark theme"
    onclick={ontoggletheme}>◐</button
  >
</header>
