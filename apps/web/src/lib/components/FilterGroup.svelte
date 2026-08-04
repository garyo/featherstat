<script lang="ts">
import { BaseDimensionSchema, type SegmentInfo } from '@featherstat/shared';
import { ROW_OPS } from '../filter-builder.ts';
import type { DraftGroup, DraftPath } from '../filter-tree.ts';
import Self from './FilterGroup.svelte';

/**
 * One group of the expression editor, and the conditions inside it — recursive,
 * because the grammar is (docs/05 § Filters). This file owns the condition row
 * and the group frame; `ownership.guard.ts` holds it to that, so a second
 * filter editor cannot quietly grow a second spelling of the same controls.
 *
 * It renders and reports. Every edit goes back up as a path plus an intent, and
 * `FilterEditor` applies it through the pure helpers in `lib/filter-tree.ts` —
 * so the tree logic stays testable without a Svelte compiler.
 */
interface Props {
  group: DraftGroup;
  /** Where this group sits; `[]` is the root, which shows no frame of its own. */
  path: DraftPath;
  segments: readonly SegmentInfo[] | undefined;
  /** The path the draft was refused at, if any — the row wears the message. */
  errorPath: DraftPath | undefined;
  errorMessage: string | undefined;
  onedit: (path: DraftPath, intent: EditIntent) => void;
}

export type EditIntent =
  /** ONLY the field that changed. The editor merges against the live tree, so
   * two edits landing before a re-render cannot restore each other's stale
   * values — which is exactly what sending the whole row used to do. */
  | { type: 'set-leaf'; dim?: string; op?: string; value?: string; session?: boolean }
  | { type: 'set-op'; op: 'all' | 'any' }
  | { type: 'negate' }
  | { type: 'remove' }
  | { type: 'wrap' }
  | { type: 'unwrap' }
  | { type: 'add-condition' }
  | { type: 'add-group' }
  | { type: 'set-segment'; segment: number };

let { group, path, segments, errorPath, errorMessage, onedit }: Props = $props();

const dims = BaseDimensionSchema.options;
const root = $derived(path.length === 0);

function samePath(a: DraftPath, b: DraftPath | undefined): boolean {
  return b !== undefined && a.length === b.length && a.every((step, i) => step === b[i]);
}

const leafEdit = (patch: Omit<Extract<EditIntent, { type: 'set-leaf' }>, 'type'>): EditIntent => ({
  type: 'set-leaf',
  ...patch,
});
</script>

<div class="fgroup" class:nested={!root} class:negated={group.negated}>
  {#if !root}
    <div class="ghead">
      <label class="gneg">
        <input
          type="checkbox"
          checked={group.negated}
          onchange={() => onedit(path, { type: 'negate' })}
        />
        NOT
      </label>
      <select
        class="gop"
        aria-label="Match all or any"
        value={group.op}
        onchange={(e) =>
          onedit(path, {
            type: 'set-op',
            op: (e.currentTarget as HTMLSelectElement).value as 'all' | 'any',
          })}
      >
        <option value="all">match all</option>
        <option value="any">match any</option>
      </select>
      <div class="spacer"></div>
      <button class="btn subtle" type="button" onclick={() => onedit(path, { type: 'unwrap' })}>
        Ungroup
      </button>
      <button
        class="btn subtle"
        type="button"
        aria-label="Remove group"
        onclick={() => onedit(path, { type: 'remove' })}>×</button
      >
    </div>
  {/if}

  {#each group.children as child, index (child.id)}
    {@const childPath = [...path, index]}
    {#if child.kind === 'group'}
      <Self group={child} path={childPath} {segments} {errorPath} {errorMessage} {onedit} />
    {:else if child.kind === 'segment'}
      <div class="cond-row">
        <span class="cond-lead">Segment</span>
        <select
          class="field grow"
          aria-label="Segment"
          value={String(child.segment)}
          onchange={(e) =>
            onedit(childPath, {
              type: 'set-segment',
              segment: Number((e.currentTarget as HTMLSelectElement).value),
            })}
        >
          {#each segments ?? [] as info (info.id)}
            <option value={String(info.id)}>{info.name}</option>
          {/each}
        </select>
        <button
          class="btn subtle"
          type="button"
          aria-label="Remove condition"
          onclick={() => onedit(childPath, { type: 'remove' })}>×</button
        >
      </div>
    {:else}
      <div class="cond-row" class:bad={samePath(childPath, errorPath)}>
        <input
          class="field fdim"
          list="filter-dims"
          aria-label="Dimension"
          value={child.row.dim}
          oninput={(e) =>
            onedit(childPath, leafEdit({ dim: (e.currentTarget as HTMLInputElement).value }))}
        />
        <select
          class="field fop"
          aria-label="Operator"
          value={child.row.op}
          onchange={(e) =>
            onedit(childPath, leafEdit({ op: (e.currentTarget as HTMLSelectElement).value }))}
        >
          {#each ROW_OPS as { op, label } (op)}<option value={op}>{label}</option>{/each}
        </select>
        {#if child.row.op !== 'is_null'}
          <input
            class="field grow"
            aria-label="Value"
            placeholder={child.row.op === 'in' ? 'a, b, c' : 'value'}
            value={child.row.value}
            oninput={(e) =>
              onedit(childPath, leafEdit({ value: (e.currentTarget as HTMLInputElement).value }))}
          />
        {/if}
        <!-- One cluster: these three travel together, so a narrow row can never
             leave the × stranded on a line of its own. -->
        <span class="cond-tail">
          <label class="scope" title="Match any hit in the session, not just this one">
            <input
              type="checkbox"
              checked={child.scope === 'session'}
              onchange={(e) =>
                onedit(
                  childPath,
                  leafEdit({ session: (e.currentTarget as HTMLInputElement).checked }),
                )}
            />
            session
          </label>
          <button
            class="btn subtle"
            type="button"
            title="Group this with another condition"
            aria-label="Group this condition"
            onclick={() => onedit(childPath, { type: 'wrap' })}>( )</button
          >
          <button
            class="btn subtle"
            type="button"
            aria-label="Remove condition"
            onclick={() => onedit(childPath, { type: 'remove' })}>×</button
          >
        </span>
      </div>
      {#if samePath(childPath, errorPath) && errorMessage !== undefined}
        <p class="form-error" role="alert">{errorMessage}</p>
      {/if}
    {/if}
  {/each}

  {#if group.children.length === 0}
    <p class="widget-note">Nothing here yet — add a condition.</p>
  {/if}

  <div class="gadd">
    <button class="btn" type="button" onclick={() => onedit(path, { type: 'add-condition' })}>
      + condition
    </button>
    <button class="btn subtle" type="button" onclick={() => onedit(path, { type: 'add-group' })}>
      + group
    </button>
  </div>
  {#if root}
    <datalist id="filter-dims">
      {#each dims as dim (dim)}<option value={dim}></option>{/each}
    </datalist>
  {/if}
</div>

<style>
  .fgroup {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .nested {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    margin-left: 10px;
  }

  .negated {
    border-color: color-mix(in srgb, var(--s1) 55%, var(--border));
  }

  .ghead,
  .cond-row,
  .gadd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .cond-row.bad .field {
    border-color: var(--bad, #c0392b);
  }

  .cond-lead {
    font-size: 12px;
    color: var(--ink-2);
  }

  .spacer {
    flex: 1;
  }

  .gneg,
  .scope {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    color: var(--ink-2);
    white-space: nowrap;
  }

  .cond-tail {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .fdim {
    flex: 0 1 140px;
    min-width: 0;
  }

  .fop {
    flex: 0 0 auto;
  }

  .grow {
    flex: 1 1 100px;
    min-width: 0;
  }
</style>
