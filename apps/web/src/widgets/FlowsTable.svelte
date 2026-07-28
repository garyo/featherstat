<script lang="ts">
import {
  type EdgeRef,
  flowRows,
  flowsThroughEdge,
  foldMiddle,
  journeyStep,
  percent,
} from './flows.ts';
import { compactNumber, formatDuration } from './format.ts';
import type { Slice } from './types.ts';

/**
 * The top-journeys table under the sankey (docs/05 R21, mockup's Top journeys
 * card): →-joined steps with the orange event dot, a wash bar behind sessions,
 * compact avg time, exit rate. A selected sankey edge narrows the rows —
 * client-side over the already-loaded flows result (the view's single batch
 * carried both widgets), so selection never re-queries.
 */
interface Props {
  slice: Slice;
  /** The flows query's signature length — journeys SHORTER than it exited by
   * definition, so their exit rate carries no information and renders as "—". */
  steps: number;
  selected: EdgeRef | undefined;
  onclear: () => void;
}

let { slice, steps, selected, onclear }: Props = $props();

const rows = $derived(slice.kind === 'ready' ? flowRows(slice.result.rows) : []);
const shown = $derived(selected === undefined ? rows : flowsThroughEdge(rows, selected));
/** What the filtered rows cover of the clicked edge — the sankey counts ALL
 * sessions, this table only its top rows, and the difference must be said. */
const shownSessions = $derived(shown.reduce((sum, row) => sum + row.sessions, 0));
</script>

{#if slice.kind === 'loading'}
  <p class="widget-note">Loading…</p>
{:else if slice.kind === 'error'}
  <p class="widget-note">{slice.message}</p>
{:else if rows.length === 0}
  <p class="widget-note">No journeys in this range.</p>
{:else}
  {#if selected !== undefined}
    <p class="flow-filter">
      Journeys through {journeyStep(selected.from).text}
      <span class="j-sep">→</span>{journeyStep(selected.to).text} at step {selected.step}
      {#if selected.sessions !== undefined}
        · {compactNumber(shownSessions)} of {compactNumber(selected.sessions)} sessions are in the
        top journeys shown
      {/if}
      <button class="retry" type="button" onclick={onclear}>Clear</button>
    </p>
  {/if}
  <div class="j-row head" aria-hidden="true">
    <span>Journey</span>
    <span class="j-num">Sessions</span>
    <span class="j-num">Avg time</span>
    <span class="j-num">Exit rate</span>
  </div>
  {#each shown as row (JSON.stringify(row.steps))}
    {@const fold = foldMiddle(row.steps)}
    <div class="j-row">
      <span class="j-steps">
        {#each fold.head as label, i (i)}
          {#if i > 0}<span class="j-sep">→</span>{/if}
          {@const step = journeyStep(label)}
          {#if step.event}<span class="evt-dot"></span>{/if}{step.text}
        {/each}
        {#if fold.folded > 0}
          <span class="j-sep">→</span>
          <span class="j-fold" title="{fold.folded} more steps">…</span>
          {#each fold.tail as label, i (i)}
            {@const step = journeyStep(label)}
            <span class="j-sep">→</span>
            {#if step.event}<span class="evt-dot"></span>{/if}{step.text}
          {/each}
        {/if}
      </span>
      <span class="j-num sess">
        <span class="bar" style="width: {row.pct.toFixed(1)}%"></span>
        <span class="n" title="{row.sessions.toLocaleString('en-US')} sessions"
          >{compactNumber(row.sessions)}</span
        >
      </span>
      <span class="j-num">{formatDuration(row.avgMs)}</span>
      {#if row.steps.length < steps}
        <span class="j-num" title="Every session this short ended here — the rate says nothing"
          >—</span
        >
      {:else}
        <span class="j-num">{percent(row.exitRate)}</span>
      {/if}
    </div>
  {:else}
    <p class="widget-note">No journeys through this step.</p>
  {/each}
{/if}

<style>
  /* Mockup .j-row grammar, plus the sessions wash bar and exit-rate column. */
  .j-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 110px 84px 72px;
    align-items: center;
    padding: 5px 8px;
    border-radius: 5px;
  }

  .j-row:hover {
    background: color-mix(in srgb, var(--ink) 5%, transparent);
  }

  .j-row.head {
    color: var(--muted);
    font-size: 12px;
  }

  .j-row.head:hover {
    background: none;
  }

  .j-steps {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .j-sep {
    color: var(--muted);
    padding: 0 6px;
  }

  .j-fold {
    color: var(--muted);
  }

  .j-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
  }

  /* Sessions wear a wash bar (sequential single hue), number on top in ink. */
  .sess {
    position: relative;
  }

  .sess .bar {
    position: absolute;
    inset: 3px auto 3px 0;
    background: var(--wash);
    border-radius: 0 4px 4px 0;
  }

  .sess .n {
    position: relative;
  }

  .flow-filter {
    margin: 0 0 6px;
    padding: 0 8px;
    color: var(--ink-2);
    font-size: 12.5px;
  }

  /* Narrow screens: the numeric columns shrink to compact fixed tracks and the
   * journey — the row's whole point — keeps the rest and may wrap. */
  @media (max-width: 600px) {
    .j-row {
      grid-template-columns: minmax(0, 1fr) 58px 56px 44px;
      font-size: 12px;
    }

    .j-row.head {
      font-size: 11px;
    }

    .j-steps {
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .j-sep {
      padding: 0 3px;
    }
  }
</style>
