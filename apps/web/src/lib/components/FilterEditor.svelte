<script lang="ts">
import type { FilterNode, FilterOp, SegmentInfo } from '@featherstat/shared';
import { emptyRow } from '../filter-builder.ts';
import {
  type DraftGroup,
  type DraftPath,
  draftOfNodes,
  groupDraft,
  insertAt,
  leafDraft,
  nodeAt,
  nodesOf,
  removeAt,
  replaceAt,
  segmentDraft,
  setGroupOp,
  setLeaf,
  toggleNegated,
  unwrapAt,
  wrapAt,
} from '../filter-tree.ts';
import { chipLabel } from '../filters.ts';
import FilterGroup, { type EditIntent } from './FilterGroup.svelte';
import Modal from './Modal.svelte';

/**
 * The one filter editor (docs/05 § Filters): nested all/any groups over the
 * shared grammar, mounted both from a view's filter row and from Settings'
 * query objects. It edits a DRAFT (`lib/filter-tree.ts`) and only converts on
 * Apply, so a half-typed condition is a message rather than a lost expression.
 *
 * Every edit routes through one `apply` — the intent comes up from the group
 * with a path, the pure helper does the work. Nothing here reaches into a tree
 * by hand, which is what keeps the tree behavior testable without a compiler.
 */
interface Props {
  title?: string;
  filters: readonly FilterNode[];
  /** Saved segments to offer as conditions; omitted where refs are not allowed
   * (a stored segment cannot reference a segment — docs/04 § 3). */
  segments?: readonly SegmentInfo[];
  /** Offered only to a principal who may write one. Resolves on success. */
  onsavesegment?: (name: string, filters: readonly FilterNode[]) => Promise<string | undefined>;
  onapply: (filters: FilterNode[]) => void;
  onclose: () => void;
}

let { title = 'Filter', filters, segments, onsavesegment, onapply, onclose }: Props = $props();

// svelte-ignore state_referenced_locally
let root = $state<DraftGroup>(draftOfNodes(filters));
let saveName = $state('');
let saving = $state(false);
let saveError = $state<string | undefined>(undefined);

const converted = $derived(nodesOf(root));
const error = $derived('error' in converted ? converted.error : undefined);
/**
 * The whole expression as ONE node before labelling. Labelling each top-level
 * node separately and joining on " and " loses the parentheses — "A and B or C"
 * for what is really "A and (B or C)" — because each node believed it stood
 * alone. As one `all` node, every group below it nests and parenthesizes.
 */
const preview = $derived.by(() => {
  if (!('nodes' in converted)) return undefined;
  const [first, ...rest] = converted.nodes;
  if (first === undefined) return '';
  return chipLabel(rest.length === 0 ? first : { all: converted.nodes }, segmentNames);
});
const segmentNames = $derived(new Map((segments ?? []).map((info) => [info.id, info.name])));

function apply(path: DraftPath, intent: EditIntent): void {
  switch (intent.type) {
    case 'set-leaf': {
      // Merge against the CURRENT node, never against what the row was rendered
      // with: two inputs changing before a re-render would otherwise each write
      // back the other's stale value.
      const node = nodeAt(root, path);
      if (node?.kind !== 'leaf') return;
      const session = intent.session ?? node.scope === 'session';
      root = setLeaf(
        root,
        path,
        {
          dim: intent.dim ?? node.row.dim,
          op: (intent.op ?? node.row.op) as FilterOp,
          value: intent.value ?? node.row.value,
        },
        session ? 'session' : 'hit',
      );
      return;
    }
    case 'set-segment': {
      root = replaceAt(root, path, segmentDraft(intent.segment));
      return;
    }
    case 'set-op':
      root = setGroupOp(root, path, intent.op);
      return;
    case 'negate':
      root = toggleNegated(root, path);
      return;
    case 'remove':
      root = removeAt(root, path);
      return;
    case 'wrap':
      root = wrapAt(root, path, 'any');
      return;
    case 'unwrap':
      root = unwrapAt(root, path);
      return;
    case 'add-condition':
      root = insertAt(root, path, leafDraft(emptyRow()));
      return;
    case 'add-group':
      root = insertAt(root, path, groupDraft('any', [leafDraft(emptyRow())]));
      return;
  }
}

function addSegmentRef(): void {
  const first = segments?.[0];
  if (first !== undefined) root = insertAt(root, [], segmentDraft(first.id));
}

function submit(): void {
  if ('nodes' in converted) onapply(converted.nodes);
}

async function saveSegment(): Promise<void> {
  if (onsavesegment === undefined || !('nodes' in converted) || saveName.trim() === '') return;
  saving = true;
  saveError = undefined;
  saveError = await onsavesegment(saveName.trim(), converted.nodes);
  saving = false;
  if (saveError === undefined) saveName = '';
}
</script>

<Modal {title} size="wide" {onclose}>
  <FilterGroup
    group={root}
    path={[]}
    {segments}
    errorPath={error?.path}
    errorMessage={error?.message}
    onedit={apply}
  />

  {#if segments !== undefined && segments.length > 0}
    <button class="btn subtle addseg" type="button" onclick={addSegmentRef}>+ saved segment</button>
  {/if}

  <p class="widget-note reading">
    {#if error !== undefined}
      {error.message}
    {:else if preview === undefined || preview === ''}
      No filter — every visit counts.
    {:else}
      {preview}
    {/if}
  </p>

  {#if onsavesegment !== undefined}
    <div class="saverow">
      <input
        class="field grow"
        placeholder="Save this as a segment…"
        aria-label="Segment name"
        bind:value={saveName}
      />
      <button
        class="btn"
        type="button"
        disabled={saving || saveName.trim() === '' || error !== undefined}
        onclick={() => void saveSegment()}>{saving ? 'Saving…' : 'Save'}</button
      >
    </div>
    {#if saveError !== undefined}<p class="form-error" role="alert">{saveError}</p>{/if}
  {/if}

  <div class="foot">
    <button class="btn subtle" type="button" onclick={() => (root = groupDraft('all'))}>
      Clear all
    </button>
    <div class="spacer"></div>
    <button class="btn" type="button" onclick={onclose}>Cancel</button>
    <button class="btn primary" type="button" disabled={error !== undefined} onclick={submit}>
      Apply
    </button>
  </div>
</Modal>

<style>
  .reading {
    margin: 10px 0 0;
    font-style: italic;
  }

  .addseg {
    margin-top: 6px;
    align-self: flex-start;
  }

  .saverow,
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }

  .spacer {
    flex: 1;
  }

  .grow {
    flex: 1 1 auto;
    min-width: 0;
  }
</style>
