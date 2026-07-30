<script lang="ts">
import type { RealtimeHit, SiteInfo } from '@featherstat/shared';
import { actionLabel, placeLabel, relativeAgo } from '../lib/realtime.ts';
import type { SiteScope } from '../lib/state.ts';
import { dotColor } from './alias-colors.ts';
import { displayDuration } from './format.ts';
import { countryName, flagEmoji } from './geo.ts';

/**
 * The live feed's rows — the ONE implementation, rendered by both the Realtime
 * view and the `feed` widget. Hover is a prop rather than local state so the
 * Realtime view can share one highlight across its tally and its feed; the
 * widget just holds its own.
 *
 * Anything a feed row should show belongs here. A caller that renders
 * `.feed-row` itself has forked the feed — see feed-rows.test.ts, which fails
 * if a second file grows that markup.
 */
interface Props {
  hits: readonly RealtimeHit[];
  now: number;
  /** Site badges appear only when the view is mixing sites. */
  scope: SiteScope;
  /** The site directory, or null on a page that has none. */
  sites: ReadonlyMap<number, SiteInfo> | null;
  /** The `ref` under the cursor — never the alias (invariant 8). */
  hover?: string | undefined;
  onhover?: (ref: string | undefined) => void;
}

let { hits, now, scope, sites, hover, onhover }: Props = $props();

const siteNameOf = (id: number): string => sites?.get(id)?.name ?? `Site ${id}`;
</script>

<div class="feed" role="list">
  {#each hits as hit, i (i)}
    {@const spent = displayDuration(hit.engagedMs)}
    <div
      class="feed-row"
      role="listitem"
      class:hl={hover === hit.visitor.ref}
      onmouseenter={() => onhover?.(hit.visitor.ref)}
      onmouseleave={() => onhover?.(undefined)}
    >
      <span class="ago">{relativeAgo(hit.ts, now)}</span>
      <span class="vdot" style="background: {dotColor(hit.visitor.color)}"></span>
      <span class="vname">{hit.visitor.name}</span>
      {#if spent !== undefined}<span class="vtime">{spent}</span>{/if}
      {#if hit.country !== undefined}
        {@const flag = flagEmoji(hit.country)}
        {#if flag !== undefined}<span class="flag" title={countryName(hit.country)}>{flag}</span
          >{/if}
      {/if}
      <span class="where">{placeLabel(hit)}</span>
      <span class="path">
        {#if hit.type === 'event'}<span class="evt-dot"></span>{/if}{actionLabel(hit)}
      </span>
      {#if scope === 'all'}<span class="fsite">{siteNameOf(hit.siteId)}</span>{/if}
    </div>
  {/each}
</div>
