<script lang="ts">
import {
  type DerivedMetricInfo,
  type FilterNode,
  filterSegmentRefs,
  type GoalInfo,
  type SegmentFilterNode,
  type SegmentInfo,
  type SiteInfo,
} from '@featherstat/shared';
import type { AdminClient } from '../../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../../lib/admin-failure.ts';
import { adminObjects } from '../../lib/admin-objects.ts';
import type { AuthRole } from '../../lib/auth.svelte.ts';
import ConfirmButton from '../../lib/components/ConfirmButton.svelte';
import FilterEditor from '../../lib/components/FilterEditor.svelte';
import {
  describeFilter,
  emptyRow,
  type FilterRow,
  leavesOf,
  nodeOf,
  parseFilterJson,
  parseFilterListJson,
  rowsOf,
  rowsOfNodes,
} from '../../lib/filter-builder.ts';
import FilterBuilder from './FilterBuilder.svelte';
import PanelError from './PanelError.svelte';

/**
 * The query-object panels (docs/04 § 3): saved segments, derived metrics and
 * goals — the three stored vocabularies a query may name (`{segment: id}`,
 * `d:<name>`, `goal:<id>:…`). Deleting one breaks the queries that name it;
 * each list says so in its own words. Segments and goals share the row-based
 * filter editor; the JSON mode is the full grammar.
 */
interface Props {
  admin: AdminClient;
  sites: SiteInfo[] | undefined;
  /** Segments and derived metrics are global-namespace objects — admin-write. */
  role?: AuthRole;
}

let { admin, sites, role = 'admin' }: Props = $props();
// svelte-ignore state_referenced_locally
const api = adminObjects(admin);

/** One editor draft over the shared filter grammar (segments and goals alike). */
interface FilterDraft {
  rows: FilterRow[];
  json: string;
  advanced: boolean;
  error: string | undefined;
}

const freshFilter = (): FilterDraft => ({
  rows: [emptyRow()],
  json: '',
  advanced: false,
  error: undefined,
});

/**
 * The visual expression editor (`lib/components/FilterEditor.svelte`) over one
 * of these drafts — the same component the dashboard filter row opens, so
 * any/not/session are buildable here rather than only typeable as JSON.
 *
 * It reads and writes the draft through the JSON mode, which is already the
 * draft's full-grammar representation: no third spelling of a filter, and the
 * rows mode still round-trips whatever it can represent.
 */
let visualOpen = $state<'segment' | 'goal' | undefined>(undefined);
let visualNodes = $state<FilterNode[]>([]);

function openVisual(which: 'segment' | 'goal'): void {
  const draft = which === 'segment' ? seg : goal;
  draft.error = undefined;
  visualNodes = nodesOfDraft(draft, which);
  visualOpen = which;
}

/** The draft as wire nodes, from whichever mode is showing; junk opens empty. */
function nodesOfDraft(draft: FilterDraft, which: 'segment' | 'goal'): FilterNode[] {
  if (!draft.advanced) {
    const leaves = leavesOf(draft.rows);
    return 'error' in leaves ? [] : leaves.leaves;
  }
  if (which === 'goal') {
    const parsed = parseFilterListJson(draft.json);
    return 'error' in parsed ? [] : parsed.nodes;
  }
  const parsed = parseFilterJson(draft.json);
  return 'error' in parsed ? [] : [parsed.node];
}

/** Applying writes back as JSON — the mode that can hold anything it built. */
function applyVisual(built: FilterNode[]): void {
  const which = visualOpen;
  if (which === undefined) return;
  const draft = which === 'segment' ? seg : goal;
  const nodes = storable(built);
  if (nodes === undefined) {
    draft.error = 'a stored filter cannot reference a segment';
    visualOpen = undefined;
    return;
  }
  const [first, ...rest] = nodes;
  const value: SegmentFilterNode | SegmentFilterNode[] =
    which === 'goal' ? nodes : rest.length === 0 && first !== undefined ? first : { all: nodes };
  draft.json = JSON.stringify(value, null, 2);
  draft.advanced = true;
  draft.error = undefined;
  // Back to rows when they can hold it — the simpler editor stays the default.
  const rows = Array.isArray(value) ? rowsOfNodes(value) : rowsOf(value);
  if (rows !== undefined && rows.length > 0) {
    draft.rows = rows;
    draft.advanced = false;
  }
  visualOpen = undefined;
}

/**
 * Segments and goals store the grammar WITHOUT segment refs (docs/04 § 3), and
 * that is what makes cycles impossible by construction. The editor is mounted
 * here with no segment picker, so this should never fire — checked rather than
 * asserted, because a cast would make it a silent 400 from the server instead.
 */
function storable(nodes: readonly FilterNode[]): SegmentFilterNode[] | undefined {
  if (nodes.some((node) => filterSegmentRefs(node).length > 0)) return undefined;
  return nodes as SegmentFilterNode[];
}

// ---------- segments ----------
let segments = $state<SegmentInfo[] | undefined>(undefined);
let segmentsFailed = $state(false);
let segName = $state('');
let segEditing = $state<number | undefined>(undefined);
let segOpen = $state(false);
let seg = $state<FilterDraft>(freshFilter());
let segBusy = $state(false);
/** The server's refusal of a save, beside the Save button; `seg.error` is the
 *  draft's own complaint, which the filter editor renders. */
let segError = $state<PanelFailure | undefined>(undefined);
let segRowError = $state<PanelFailure | undefined>(undefined);

const loadSegments = (): Promise<void> =>
  api
    .listSegments()
    .then((list) => {
      segments = list;
    })
    .catch(() => {
      segmentsFailed = true;
    });
$effect(() => {
  void loadSegments();
});

function openSegment(info?: SegmentInfo): void {
  segOpen = true;
  segEditing = info?.id;
  segName = info?.name ?? '';
  seg = freshFilter();
  if (info === undefined) return;
  const rows = rowsOf(info.filter);
  if (rows === undefined || rows.length === 0) {
    seg.advanced = true;
    seg.json = JSON.stringify(info.filter, null, 2);
  } else {
    seg.rows = rows;
  }
}

function toggleSegmentEditor(): void {
  seg.error = undefined;
  if (seg.advanced) {
    const parsed = parseFilterJson(seg.json);
    if ('error' in parsed) {
      seg.error = parsed.error;
      return;
    }
    const rows = rowsOf(parsed.node);
    if (rows === undefined) {
      seg.error = 'this tree uses any/not/session scope — only the JSON editor can say it';
      return;
    }
    seg.rows = rows.length === 0 ? [emptyRow()] : rows;
    seg.advanced = false;
  } else {
    const leaves = leavesOf(seg.rows);
    seg.json = JSON.stringify('error' in leaves ? nodeOf([]) : nodeOf(leaves.leaves), null, 2);
    seg.advanced = true;
  }
}

async function saveSegment(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  seg.error = undefined;
  let filter: ReturnType<typeof parseFilterJson>;
  if (seg.advanced) {
    filter = parseFilterJson(seg.json);
  } else {
    const leaves = leavesOf(seg.rows);
    if ('error' in leaves) {
      seg.error = `condition ${leaves.row + 1}: ${leaves.error}`;
      return;
    }
    filter = { node: nodeOf(leaves.leaves) };
  }
  if ('error' in filter) {
    seg.error = filter.error;
    return;
  }
  segBusy = true;
  segError = undefined;
  try {
    const body = { name: segName.trim(), filter: filter.node };
    if (segEditing === undefined) await api.createSegment(body);
    else await api.updateSegment(segEditing, body);
    segOpen = false;
    await loadSegments();
  } catch (failure) {
    segError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    segBusy = false;
  }
}

async function deleteSegment(id: number): Promise<void> {
  segRowError = undefined;
  try {
    await api.deleteSegment(id);
    await loadSegments();
  } catch (failure) {
    segRowError = panelFailure(failure, 'Deleting failed — try again.');
  }
}

// ---------- derived metrics ----------
let metrics = $state<DerivedMetricInfo[] | undefined>(undefined);
let derivedFailed = $state(false);
let dmName = $state('');
let dmExpr = $state('');
let dmEditing = $state<number | undefined>(undefined);
let dmOpen = $state(false);
let dmBusy = $state(false);
let dmError = $state<PanelFailure | undefined>(undefined);
let dmRowError = $state<PanelFailure | undefined>(undefined);

const loadDerived = (): Promise<void> =>
  api
    .listDerivedMetrics()
    .then((list) => {
      metrics = list;
    })
    .catch(() => {
      derivedFailed = true;
    });
$effect(() => {
  void loadDerived();
});

function openDerived(info?: DerivedMetricInfo): void {
  dmOpen = true;
  dmEditing = info?.id;
  dmName = info?.name ?? '';
  dmExpr = info?.expr ?? '';
  dmError = undefined;
}

async function saveDerived(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  dmBusy = true;
  dmError = undefined;
  try {
    const body = { name: dmName.trim(), expr: dmExpr.trim() };
    if (dmEditing === undefined) await api.createDerivedMetric(body);
    else await api.updateDerivedMetric(dmEditing, body);
    dmOpen = false;
    await loadDerived();
  } catch (failure) {
    dmError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    dmBusy = false;
  }
}

async function deleteDerived(id: number): Promise<void> {
  dmRowError = undefined;
  try {
    await api.deleteDerivedMetric(id);
    await loadDerived();
  } catch (failure) {
    dmRowError = panelFailure(failure, 'Deleting failed — try again.');
  }
}

// ---------- goals ----------
let goalSite = $state<number | undefined>(undefined);
const goalSiteId = $derived(goalSite ?? sites?.[0]?.id);
let goals = $state<GoalInfo[] | undefined>(undefined);
let goalsFailed = $state(false);
let goalName = $state('');
let goalEditing = $state<number | undefined>(undefined);
let goalOpen = $state(false);
let goal = $state<FilterDraft>(freshFilter());
let goalValueKind = $state<'none' | 'event_value' | 'fixed'>('none');
let goalFixed = $state('');
let goalTarget = $state('');
let goalBusy = $state(false);
let goalError = $state<PanelFailure | undefined>(undefined);
let goalRowError = $state<PanelFailure | undefined>(undefined);

$effect(() => {
  if (goalSiteId === undefined) return;
  goals = undefined;
  void api
    .listGoals(goalSiteId)
    .then((list) => {
      goals = list;
    })
    .catch(() => {
      goalsFailed = true;
    });
});

function openGoal(info?: GoalInfo): void {
  goalOpen = true;
  goalEditing = info?.id;
  goalName = info?.name ?? '';
  goal = freshFilter();
  goalValueKind =
    info?.valueExpr == null ? 'none' : info.valueExpr === 'event_value' ? 'event_value' : 'fixed';
  goalFixed =
    info?.valueExpr != null && info.valueExpr !== 'event_value' ? String(info.valueExpr.fixed) : '';
  goalTarget = info?.target == null ? '' : String(info.target);
  if (info === undefined) return;
  const rows = rowsOfNodes(info.filters);
  if (rows === undefined || rows.length === 0) {
    goal.advanced = true;
    goal.json = JSON.stringify(info.filters, null, 2);
  } else {
    goal.rows = rows;
  }
}

function toggleGoalEditor(): void {
  goal.error = undefined;
  if (goal.advanced) {
    const parsed = parseFilterListJson(goal.json);
    if ('error' in parsed) {
      goal.error = parsed.error;
      return;
    }
    const rows = rowsOfNodes(parsed.nodes);
    if (rows === undefined) {
      goal.error = 'this tree uses any/not/session scope — only the JSON editor can say it';
      return;
    }
    goal.rows = rows.length === 0 ? [emptyRow()] : rows;
    goal.advanced = false;
  } else {
    const leaves = leavesOf(goal.rows);
    goal.json = JSON.stringify('error' in leaves ? [] : leaves.leaves, null, 2);
    goal.advanced = true;
  }
}

async function saveGoal(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (goalSiteId === undefined) return;
  goal.error = undefined;
  let filters: ReturnType<typeof parseFilterListJson>;
  if (goal.advanced) {
    filters = parseFilterListJson(goal.json);
  } else {
    const leaves = leavesOf(goal.rows);
    if ('error' in leaves) {
      goal.error = `condition ${leaves.row + 1}: ${leaves.error}`;
      return;
    }
    filters = { nodes: leaves.leaves };
  }
  if ('error' in filters) {
    goal.error = filters.error;
    return;
  }
  const fixed = Number(goalFixed);
  if (goalValueKind === 'fixed' && !Number.isFinite(fixed)) {
    goal.error = 'the fixed value must be a number';
    return;
  }
  const target = goalTarget.trim() === '' ? null : Number(goalTarget);
  if (target !== null && !(Number.isFinite(target) && target > 0)) {
    goal.error = 'the target must be a positive number';
    return;
  }
  goalBusy = true;
  goalError = undefined;
  try {
    const body = {
      name: goalName.trim(),
      filters: filters.nodes,
      valueExpr:
        goalValueKind === 'none'
          ? null
          : goalValueKind === 'event_value'
            ? ('event_value' as const)
            : { fixed },
      target,
    };
    if (goalEditing === undefined) await api.createGoal(goalSiteId, body);
    else await api.updateGoal(goalEditing, body);
    goalOpen = false;
    goals = await api.listGoals(goalSiteId);
  } catch (failure) {
    goalError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    goalBusy = false;
  }
}

async function deleteGoal(id: number): Promise<void> {
  if (goalSiteId === undefined) return;
  goalRowError = undefined;
  try {
    await api.deleteGoal(id);
    goals = await api.listGoals(goalSiteId);
  } catch (failure) {
    goalRowError = panelFailure(failure, 'Deleting failed — try again.');
  }
}
</script>

{#if role === 'admin'}
<div class="card c6">
  <h2>Segments</h2>
  <p class="widget-note">
    Named filter trees any query can reference. Deleting one makes the queries that name it answer
    with an error instead of silently widening.
  </p>
  {#if segmentsFailed}
    <p class="widget-note">Segments unavailable.</p>
  {:else if segments === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each segments as info (info.id)}
      <div class="prow">
        <div class="pmeta">
          <span class="pname">{info.name}</span>
          <span class="psub">{describeFilter(info.filter)}</span>
        </div>
        <button class="btn subtle" type="button" onclick={() => openSegment(info)}>Edit</button>
        <ConfirmButton
          label="Delete"
          confirm="Really delete? Queries naming it will fail."
          pending="Deleting…"
          onconfirm={() => deleteSegment(info.id)}
        />
      </div>
    {:else}
      <p class="widget-note">No segments yet.</p>
    {/each}
    <PanelError failure={segRowError} />
    {#if segOpen}
      <form class="oform" onsubmit={saveSegment}>
        <label class="field">
          Name
          <input bind:value={segName} maxlength="64" required />
        </label>
        <FilterBuilder
          bind:rows={seg.rows}
          bind:json={seg.json}
          bind:advanced={seg.advanced}
          error={seg.error}
          ontoggle={toggleSegmentEditor}
        />
        <button class="btn subtle" type="button" onclick={() => openVisual('segment')}>
          Build visually…
        </button>
        <PanelError failure={segError} />
        <div class="row">
          <button class="btn primary" type="submit" disabled={segBusy || segName.trim() === ''}>
            {segBusy ? 'Saving…' : 'Save segment'}
          </button>
          <button class="btn" type="button" onclick={() => (segOpen = false)}>Cancel</button>
        </div>
      </form>
    {:else}
      <button class="btn addv" type="button" onclick={() => openSegment()}>New segment</button>
    {/if}
  {/if}
</div>

<div class="card c6">
  <h2>Derived metrics</h2>
  <p class="widget-note">
    Arithmetic over the built-in metrics, usable in any query as <code>d:&lt;name&gt;</code> — e.g.
    <code>pageviews / visits</code>.
  </p>
  {#if derivedFailed}
    <p class="widget-note">Derived metrics unavailable.</p>
  {:else if metrics === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each metrics as info (info.id)}
      <div class="prow">
        <div class="pmeta">
          <span class="pname">d:{info.name}</span>
          <span class="psub">{info.expr}</span>
        </div>
        <button class="btn subtle" type="button" onclick={() => openDerived(info)}>Edit</button>
        <ConfirmButton
          label="Delete"
          confirm="Really delete? Queries naming it will fail."
          pending="Deleting…"
          onconfirm={() => deleteDerived(info.id)}
        />
      </div>
    {:else}
      <p class="widget-note">No derived metrics yet.</p>
    {/each}
    <PanelError failure={dmRowError} />
    {#if dmOpen}
      <form class="oform" onsubmit={saveDerived}>
        <label class="field">
          Name (lowercase, digits, underscores)
          <input bind:value={dmName} maxlength="32" required />
        </label>
        <label class="field">
          Expression
          <input bind:value={dmExpr} maxlength="200" placeholder="events / visits" required />
        </label>
        <PanelError failure={dmError} />
        <div class="row">
          <button
            class="btn primary"
            type="submit"
            disabled={dmBusy || dmName.trim() === '' || dmExpr.trim() === ''}
          >
            {dmBusy ? 'Saving…' : 'Save metric'}
          </button>
          <button class="btn" type="button" onclick={() => (dmOpen = false)}>Cancel</button>
        </div>
      </form>
    {:else}
      <button class="btn addv" type="button" onclick={() => openDerived()}>New derived metric</button>
    {/if}
  {/if}
</div>

{/if}

<div class="card c12">
  <h2>Goals</h2>
  <p class="widget-note">
    A goal completes once per session when any event matches its filters; its numbers ride queries
    as <code>goal:&lt;id&gt;:conversions/cr/value</code>.
  </p>
  <label class="field gsite">
    Site
    <select
      value={String(goalSiteId ?? '')}
      onchange={(e) => (goalSite = Number(e.currentTarget.value))}
    >
      {#each sites ?? [] as site (site.id)}
        <option value={String(site.id)}>{site.name}</option>
      {/each}
    </select>
  </label>
  {#if goalsFailed}
    <p class="widget-note">Goals unavailable.</p>
  {:else if goals === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each goals as info (info.id)}
      <div class="prow">
        <div class="pmeta">
          <span class="pname">{info.name}</span>
          <span class="psub">
            {info.filters.map(describeFilter).join(' and ')}
            {info.target === null ? '' : ` · target ${info.target}`}
          </span>
        </div>
        <button class="btn subtle" type="button" onclick={() => openGoal(info)}>Edit</button>
        <ConfirmButton
          label="Delete"
          confirm="Really delete? Widgets showing it will fail."
          pending="Deleting…"
          onconfirm={() => deleteGoal(info.id)}
        />
      </div>
    {:else}
      <p class="widget-note">No goals for this site yet.</p>
    {/each}
    <PanelError failure={goalRowError} />
    {#if goalOpen}
      <form class="oform" onsubmit={saveGoal}>
        <label class="field">
          Name
          <input bind:value={goalName} maxlength="64" required />
        </label>
        <FilterBuilder
          bind:rows={goal.rows}
          bind:json={goal.json}
          bind:advanced={goal.advanced}
          error={goal.error}
          ontoggle={toggleGoalEditor}
        />
        <button class="btn subtle" type="button" onclick={() => openVisual('goal')}>
          Build visually…
        </button>
        <div class="grow">
          <label class="field">
            Value per conversion
            <select bind:value={goalValueKind}>
              <option value="none">none</option>
              <option value="event_value">the matching event's value</option>
              <option value="fixed">a fixed amount</option>
            </select>
          </label>
          {#if goalValueKind === 'fixed'}
            <label class="field">
              Amount
              <input bind:value={goalFixed} inputmode="decimal" placeholder="25" />
            </label>
          {/if}
          <label class="field">
            Target (display only)
            <input bind:value={goalTarget} inputmode="numeric" placeholder="100" />
          </label>
        </div>
        <PanelError failure={goalError} />
        <div class="row">
          <button class="btn primary" type="submit" disabled={goalBusy || goalName.trim() === ''}>
            {goalBusy ? 'Saving…' : 'Save goal'}
          </button>
          <button class="btn" type="button" onclick={() => (goalOpen = false)}>Cancel</button>
        </div>
      </form>
    {:else}
      <button class="btn addv" type="button" onclick={() => openGoal()}>New goal</button>
    {/if}
  {/if}
</div>

<!-- One mount for both panels. No `segments` prop: a stored segment may not
     reference a segment, so the picker has nothing to offer here (docs/04 § 3). -->
{#if visualOpen !== undefined}
  <FilterEditor
    title={visualOpen === 'segment' ? 'Segment filter' : 'Goal filter'}
    filters={visualNodes}
    onapply={applyVisual}
    onclose={() => (visualOpen = undefined)}
  />
{/if}

<style>
  .prow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--grid);
  }

  .pmeta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .pname {
    font-weight: 600;
  }

  .psub {
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .oform {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .row {
    display: flex;
    gap: 8px;
  }

  .addv {
    margin-top: 12px;
    align-self: flex-start;
  }

  .gsite {
    max-width: 240px;
    margin-bottom: 10px;
  }

  .grow {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .grow .field {
    flex: 1 1 180px;
    min-width: 0;
  }
</style>
