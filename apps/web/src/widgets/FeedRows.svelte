<script lang="ts">
import type { RealtimeHit, SiteInfo } from '@featherstat/shared';
import { actionLabel, collapseRuns, placeLabel, relativeAgo } from '../lib/realtime.ts';
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
 *
 * A row is a RUN: one page, and every hit that landed on it. The wire carries
 * raw hits including heartbeats, and collapsing them here is what turns them
 * into time on that page (`collapseRuns`). A run of one hit renders as an
 * ordinary row, so there is exactly one markup for both cases.
 */
interface Props {
  /** Raw hits, newest first — collapsed into runs here, never by the caller. */
  hits: readonly RealtimeHit[];
  /**
   * Rows to show. Applied to RUNS, after collapsing: a caller that sliced the
   * hits instead would both show a fraction of the rows it asked for and cut
   * away the hit that measures the last one.
   */
  limit?: number;
  now: number;
  /** Site badges appear only when the view is mixing sites. */
  scope: SiteScope;
  /** The site directory, or null on a page that has none. */
  sites: ReadonlyMap<number, SiteInfo> | null;
  /** The `ref` under the cursor — never the alias (invariant 8). */
  hover?: string | undefined;
  onhover?: (ref: string | undefined) => void;
}

let { hits, now, scope, sites, hover, onhover, limit }: Props = $props();

const siteNameOf = (id: number): string => sites?.get(id)?.name ?? `Site ${id}`;
const runs = $derived(
  limit === undefined ? collapseRuns(hits) : collapseRuns(hits).slice(0, limit),
);
</script>

<div class="feed" role="list">
  {#each runs as run, i (i)}
    {@const hit = run.latest}
    {@const spent = displayDuration(run.pageMs)}
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
      {#if spent !== undefined}<span class="vtime" title="time on this page">{spent}</span>{/if}
      {#if hit.country !== undefined}
        {@const flag = flagEmoji(hit.country)}
        {#if flag !== undefined}<span class="flag" title={countryName(hit.country)}>{flag}</span
          >{/if}
      {/if}
      <span class="where">{placeLabel(hit)}</span>
      <!-- Long paths ellipsize; the native title says the whole value. -->
      <span class="path" title={actionLabel(hit)}>
        {#if hit.type === 'event'}<span class="evt-dot"></span>{/if}{actionLabel(hit)}
      </span>
      <!-- Heartbeats fold into the time silently; anything the visitor DID is
           news, so it is counted rather than absorbed. -->
      {#if run.actions > 0}<span class="acts" title="{run.actions} action{run.actions === 1
            ? ''
            : 's'} on this page">+{run.actions}</span>{/if}
      {#if scope === 'all'}<span class="fsite">{siteNameOf(hit.siteId)}</span>{/if}
    </div>
  {/each}
</div>
