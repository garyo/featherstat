<script module lang="ts">
export interface DataRow {
  key: string | number;
  /** A row header (`<th scope="row">`) — the bucket, band or day the cells describe. */
  label?: string;
  cells: readonly string[];
}
</script>

<script lang="ts">
/**
 * A chart's values without a pointer (docs/05 § Accessibility): the exact
 * numbers a drawing encodes, as a visually-hidden table screen readers walk
 * like any other. Every chart that draws values its text does not say renders
 * one of these — never its own copy of the markup (CLAUDE.md invariant 7).
 */
interface Props {
  caption: string;
  /** Column headers, when the columns need naming. */
  head?: readonly string[];
  rows: readonly DataRow[];
}

let { caption, head, rows }: Props = $props();
</script>

<!-- The wrapper is what hides it: see `.sr-only` in widgets.css. -->
<div class="sr-only">
  <table>
    <caption>{caption}</caption>
    {#if head !== undefined}
      <thead>
        <tr>
          {#each head as name, i (i)}<th scope="col">{name}</th>{/each}
        </tr>
      </thead>
    {/if}
    <tbody>
      {#each rows as row (row.key)}
        <tr>
          {#if row.label !== undefined}<th scope="row">{row.label}</th>{/if}
          {#each row.cells as cell, i (i)}<td>{cell}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
