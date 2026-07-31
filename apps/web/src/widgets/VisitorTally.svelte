<script lang="ts">
import { TALLY_WINDOW_LABEL } from '@featherstat/shared';
import {
  placeOf,
  relativeAgo,
  scopedHits,
  visitorMeta,
  visitorRows,
  visitorTrail,
} from '../lib/realtime.ts';
import { dotColor } from './alias-colors.ts';
import type { WidgetProps } from './types.ts';

/**
 * Who is here, and — when a row is opened — what they have been reading. The
 * trail comes from the feed ring the view already holds, so expanding costs no
 * query and exposes nothing the stream did not already carry.
 */
let { env }: WidgetProps = $props();

let opened = $state<string | undefined>(undefined);

const scoped = $derived(scopedHits(env.realtime, env.scope));
const visitors = $derived(visitorRows(env.realtime, env.scope, env.now));
const hover = $derived(env.highlight?.ref);
const siteNameOf = (id: number): string => env.sites?.get(id)?.name ?? `Site ${id}`;

const toggle = (ref: string): void => {
  opened = opened === ref ? undefined : ref;
};
</script>

{#if visitors.length > 0}
  <p class="tally-label">Visitors · {TALLY_WINDOW_LABEL}</p>
  <div class="visitor-tally" role="list">
    {#each visitors as row (row.ref)}
      {@const isOpen = opened === row.ref}
      <div class="visitor-row" role="listitem" class:hl={hover === row.ref}>
        <button
          class="visitor-open"
          type="button"
          aria-expanded={isOpen}
          onclick={() => toggle(row.ref)}
          onmouseenter={() => env.highlight?.onhover(row.ref)}
          onmouseleave={() => env.highlight?.onhover(undefined)}
        >
          <span class="caret" class:open={isOpen}>▸</span>
          <span class="vdot" style="background: {dotColor(row.color)}"></span>
          <span class="vname">{row.name}</span>
          <span class="vmeta"
            >· {visitorMeta(
              row,
              placeOf(row),
              env.scope === 'all' ? siteNameOf(row.siteId) : undefined,
            )}</span
          >
        </button>
      </div>
      {#if isOpen}
        {@const trail = visitorTrail(scoped, row, env.now)}
        <ol class="trail">
          {#each trail as step, i (i)}
            <li>
              <span class="ago">{relativeAgo(step.ts, env.now)}</span>
              {#if step.isEvent}<span class="evt-dot"></span>{/if}<span class="step"
                >{step.label}</span
              >
            </li>
          {/each}
        </ol>
      {/if}
    {/each}
  </div>
{/if}
