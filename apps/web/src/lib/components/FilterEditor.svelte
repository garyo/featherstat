<script lang="ts">
import {
  BaseDimensionSchema,
  type FilterNode,
  type FilterOp,
  type SegmentInfo,
} from '@featherstat/shared';
import { emptyRow } from '../filter-builder.ts';
import {
  OPERATOR_REFERENCE,
  parseFilterText,
  printFilterText,
  type TextError,
} from '../filter-text.ts';
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
import { chipLabel, DIMENSION_CHOICES } from '../filters.ts';
import { edited } from '../unsaved.ts';
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

/**
 * Text mode is a second way to SAY the expression, never a second place to keep
 * it: `root` stays the one draft. Entering prints the draft, leaving parses the
 * text back into it, and a refusal keeps the text on screen so the reader can
 * fix it rather than losing what they typed.
 */
let asText = $state(false);
let text = $state('');
let textError = $state<TextError | undefined>(undefined);

function toText(): void {
  const converted = nodesOf(root);
  if ('error' in converted) {
    // The visual editor still holds an unfinished condition; it says where.
    return;
  }
  text = printFilterText(converted.nodes, segmentNames);
  textError = undefined;
  asText = true;
}

/** Text → draft. Answers whether it took, so Apply can refuse to close on junk. */
function fromText(): boolean {
  const parsed = parseFilterText(text, segmentIds);
  if ('error' in parsed) {
    textError = parsed.error;
    return false;
  }
  root = draftOfNodes(parsed.nodes);
  textError = undefined;
  return true;
}

function toVisual(): void {
  if (fromText()) asText = false;
}

const converted = $derived(nodesOf(root));
const error = $derived('error' in converted ? converted.error : undefined);

/** The expression as opened, round-tripped the way Apply would send it — "unchanged". */
// svelte-ignore state_referenced_locally
const openedAs = nodesOf(draftOfNodes(filters));

/** Closing without Apply loses whatever differs from what was opened; ask first. */
function mayClose(): boolean {
  const now = asText ? parseFilterText(text, segmentIds) : converted;
  const unchanged = 'nodes' in now && 'nodes' in openedAs && !edited(now.nodes, openedAs.nodes);
  return unchanged || window.confirm('Discard the filter changes you have not applied?');
}

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
const segmentIds = $derived(new Map((segments ?? []).map((info) => [info.name, info.id])));
/** Generated from the zod enum, so the reference cannot drift from the parser. */
const DIMENSIONS = DIMENSION_CHOICES;

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
  // In text mode the text is the truth, so parse it before reading the draft.
  if (asText && !fromText()) return;
  const result = nodesOf(root);
  if ('nodes' in result) onapply(result.nodes);
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

<Modal {title} size="wide" {onclose} onrequestclose={mayClose}>
  {#if asText}
    <textarea
      class="filter-text"
      rows="3"
      spellcheck="false"
      aria-label="Filter expression"
      bind:value={text}
      oninput={() => (textError = undefined)}
    ></textarea>
    {#if textError !== undefined}
      <p class="form-error" role="alert">
        {textError.message} — at character {textError.index + 1}
      </p>
    {/if}
    <details class="vocab">
      <summary>What can I write here?</summary>
      <p><code>and</code> <code>or</code> <code>not</code>, brackets to group, and:</p>
      <p class="vocab-list">{OPERATOR_REFERENCE.join('  ·  ')}</p>
      <p>
        <code>session &lt;dim&gt; …</code> matches the whole visit;
        <code>segment "name"</code> names a saved one.
      </p>
      <p class="vocab-list">
        {#each DIMENSIONS as entry (entry.value)}<span class="vocab-dim"
            ><code>{entry.value}</code> {entry.label}</span
          >{/each}
      </p>
    </details>
  {:else}
    <FilterGroup
      group={root}
      path={[]}
      {segments}
      errorPath={error?.path}
      errorMessage={error?.message}
      onedit={apply}
    />

    {#if segments !== undefined && segments.length > 0}
      <button class="btn subtle addseg" type="button" onclick={addSegmentRef}>+ saved segment</button
      >
    {/if}
  {/if}

  <p class="widget-note reading">
    {#if asText}
      Applying reads this back into the conditions.
    {:else if error !== undefined}
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
    <button
      class="btn subtle"
      type="button"
      disabled={!asText && error !== undefined}
      title={!asText && error !== undefined
        ? 'Finish the condition first — text mode shows the whole expression'
        : undefined}
      onclick={() => (asText ? toVisual() : toText())}
    >
      {asText ? 'Edit as conditions' : 'Edit as text'}
    </button>
    <button
      class="btn subtle"
      type="button"
      onclick={() => {
        root = groupDraft('all');
        text = '';
        textError = undefined;
      }}
    >
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
  .filter-text {
    width: 100%;
    font: 12px/1.6 ui-monospace, monospace;
    color: var(--ink);
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 8px 10px;
    resize: vertical;
  }

  .vocab {
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--ink-2);
  }

  .vocab summary {
    cursor: pointer;
  }

  .vocab p {
    margin: 6px 0 0;
  }

  .vocab-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }

  .vocab-dim {
    white-space: nowrap;
  }

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
