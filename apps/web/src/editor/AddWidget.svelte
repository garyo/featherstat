<script lang="ts">
import {
  type Dimension,
  DimensionSchema,
  type Metric,
  MetricSchema,
  type VizType,
  VizTypeSchema,
  type WidgetSpec,
} from '@featherstat/shared';
import Modal from '../lib/components/Modal.svelte';
import { DIMENSION_CHOICES } from '../lib/filters.ts';
import { VIZ_LABELS } from '../lib/viz-labels.ts';
import { METRIC_LABELS } from '../widgets/format.ts';
import { REGISTRY } from '../widgets/registry.ts';
import { buildWidget, limitProblem } from './model.ts';

/**
 * The add-widget picker (docs/05: pick query + viz from the same vocabulary the
 * API speaks) — plain selects over the shared metric/dimension enums; the
 * factory in model.ts turns the picks into a schema-valid widget.
 */
interface Props {
  /** Grants the new widget its id — unique across the draft's widget AND query ids. */
  id: string;
  /** The dashboard's scope: site-cards is an all-sites grid and only offered there;
   * a broken link names a path without its site, so only a site dashboard offers one. */
  site: 'all' | number;
  onadd: (spec: WidgetSpec) => void;
  onclose: () => void;
}

let { id, site, onadd, onclose }: Props = $props();

const vizOptions = $derived(
  VizTypeSchema.options.filter((type) =>
    type === 'site-cards' ? site === 'all' : type !== 'broken-links' || site !== 'all',
  ),
);

let viz = $state<VizType>('bar-list');
let title = $state('');
let metrics = $state<Metric[]>(['visitors']);
let dim = $state<Dimension | ''>('path');
/** A number box binds null while it is empty. */
let limit = $state<number | null>(8);

/** Free-form vizzes take the picked breakdown; the rest pin their own query shape. */
const freeForm = $derived(viz === 'bar-list' || viz === 'table' || viz === 'map');
/** Feed has no query, but its row count is a real knob. */
const pickLimit = $derived(freeForm || viz === 'feed');
const limitError = $derived(pickLimit ? limitProblem(limit) : undefined);
/** The realtime family reads the stream: no query, no knobs beyond a title. */
/** Vizzes whose pinned query answers no metric pick — site cards, and dwell's own kind. */
const METRICLESS = new Set<VizType>([
  'site-cards',
  'dwell',
  'changes',
  'broken-links',
  'feed',
  'active-now',
  'visitor-tally',
  'realtime-countries',
]);
const pickMetrics = $derived(!METRICLESS.has(viz));

function toggleMetric(metric: Metric): void {
  metrics = metrics.includes(metric) ? metrics.filter((m) => m !== metric) : [...metrics, metric];
}

function add(): void {
  if (limitError !== undefined) return;
  onadd(
    buildWidget(
      {
        viz,
        title,
        metrics,
        dim: freeForm ? dim : '',
        limit: pickLimit ? (limit ?? undefined) : undefined,
      },
      id,
    ),
  );
}
</script>

<Modal title="Add widget" {onclose}>
  <div class="form">
    <label class="field">
      Visualization
      <select bind:value={viz}>
        {#each vizOptions as type (type)}
          <option value={type}>
            {VIZ_LABELS[type]}{REGISTRY[type] === undefined ? ' (placeholder)' : ''}
          </option>
        {/each}
      </select>
    </label>
    <label class="field">
      Title
      <input type="text" bind:value={title} placeholder="Optional" maxlength="200" />
    </label>
    {#if pickMetrics}
      <fieldset class="metrics">
        <legend>Metrics</legend>
        {#each MetricSchema.options as metric (metric)}
          <label class="check">
            <input
              type="checkbox"
              checked={metrics.includes(metric)}
              onchange={() => toggleMetric(metric)}
            />
            {METRIC_LABELS[metric]}
          </label>
        {/each}
      </fieldset>
    {/if}
    {#if freeForm}
      <label class="field">
        Breakdown
        <select bind:value={dim}>
          <option value="">(none)</option>
          {#each DIMENSION_CHOICES as choice (choice.value)}
            <option value={choice.value}>{choice.label}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if pickLimit}
      <label class="field">
        Limit
        <input
          type="number"
          bind:value={limit}
          min="1"
          max="1000"
          aria-invalid={limitError !== undefined}
          aria-describedby={limitError === undefined ? undefined : 'add-widget-limit'}
        />
      </label>
      {#if limitError !== undefined}
        <p class="form-error" id="add-widget-limit" role="alert">{limitError}</p>
      {/if}
    {/if}
    <div class="actions">
      <button class="btn" type="button" onclick={onclose}>Cancel</button>
      <button
        class="btn primary"
        type="button"
        disabled={(pickMetrics && metrics.length === 0) || limitError !== undefined}
        onclick={add}>Add widget</button
      >
    </div>
  </div>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .metrics {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px 10px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 12px;
  }

  .metrics legend {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-2);
    padding: 0 4px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>
