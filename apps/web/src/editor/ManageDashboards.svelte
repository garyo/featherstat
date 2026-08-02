<script lang="ts">
import type { AdminClient } from '../lib/admin.ts';
import type { LibraryEntry } from '../lib/dashboards.ts';
import type { DashRef, SiteScope } from '../lib/state.ts';
import Modal from './Modal.svelte';

/**
 * The dashboard library's management panel (docs/05 § The dashboard library):
 * new/rename/duplicate/reset/delete over the scope's stored rows. Templates are
 * listed read-only — customizing one is the editor's job (edit clones), and a
 * clone is what these actions then apply to. Deleting says what it revokes:
 * removing a row kills its share links in the same transaction server-side, so
 * the confirm states the count first.
 */
interface Props {
  admin: AdminClient;
  scope: SiteScope;
  library: readonly LibraryEntry[];
  /** The entry currently on screen, so a delete of it can move the view off it. */
  dash: DashRef | undefined;
  /** Reloads the library after any mutation. */
  onchanged: () => Promise<void>;
  onselectdash: (dash: DashRef | undefined) => void;
  onclose: () => void;
}

let { admin, scope, library, dash, onchanged, onselectdash, onclose }: Props = $props();

let busy = $state(false);
let error = $state<string | undefined>(undefined);
/** Row id armed for deletion — the second click deletes. */
let confirmDelete = $state<number | undefined>(undefined);
/** Row id being renamed, and the draft name. */
let renaming = $state<number | undefined>(undefined);
let renameTo = $state('');
let newName = $state('');

const stored = $derived(library.filter((entry) => entry.kind === 'stored'));
const templates = $derived(library.filter((entry) => entry.kind === 'template'));

async function run(action: () => Promise<void>): Promise<void> {
  busy = true;
  error = undefined;
  try {
    await action();
    await onchanged();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy = false;
  }
}

function create(): void {
  const name = newName.trim();
  if (name === '') return;
  void run(async () => {
    const detail = await admin.createDashboard({ version: 1, name, site: scope, grid: [] });
    newName = '';
    onselectdash(detail.id);
  });
}

function duplicate(id: number): void {
  void run(async () => {
    const detail = await admin.duplicateDashboard(id);
    onselectdash(detail.id);
  });
}

function reset(id: number): void {
  void run(async () => {
    await admin.resetDashboard(id);
  });
}

function startRename(entry: LibraryEntry & { kind: 'stored' }): void {
  renaming = entry.ref;
  renameTo = entry.name;
}

function rename(id: number): void {
  const name = renameTo.trim();
  if (name === '') return;
  void run(async () => {
    // The name is part of the layout document; a rename is a PUT of it renamed.
    const detail = await admin.getDashboard(id);
    await admin.updateDashboard(id, { ...detail.layout, name });
    renaming = undefined;
  });
}

function remove(entry: LibraryEntry & { kind: 'stored' }): void {
  if (confirmDelete !== entry.ref) {
    confirmDelete = entry.ref;
    return;
  }
  confirmDelete = undefined;
  void run(async () => {
    await admin.deleteDashboard(entry.ref);
    if (dash === entry.ref) onselectdash(undefined);
  });
}

function deleteWarning(entry: LibraryEntry & { kind: 'stored' }): string {
  const links = entry.info.shareCount;
  return links > 0
    ? `Really delete — and revoke ${links} share link${links === 1 ? '' : 's'}?`
    : 'Really delete?';
}
</script>

<Modal title="Manage dashboards" {onclose}>
  {#if error !== undefined}<p class="form-error" role="alert">{error}</p>{/if}

  {#each templates as entry (entry.ref)}
    <div class="mrow">
      <span class="mname">{entry.name}</span>
      <span class="mkind">built-in</span>
      <span class="spacer"></span>
      <button class="btn slim" type="button" disabled={busy} onclick={() => onselectdash(entry.ref)}
        >Open</button
      >
    </div>
  {/each}

  {#each stored as entry (entry.ref)}
    {#if entry.kind === 'stored'}
      <div class="mrow">
        {#if renaming === entry.ref}
          <input
            class="mname-input"
            aria-label="Dashboard name"
            bind:value={renameTo}
            onkeydown={(event) => event.key === 'Enter' && rename(entry.ref)}
          />
          <button class="btn slim" type="button" disabled={busy} onclick={() => rename(entry.ref)}
            >Save</button
          >
          <button class="btn slim" type="button" onclick={() => (renaming = undefined)}
            >Cancel</button
          >
        {:else}
          <span class="mname">{entry.name}</span>
          {#if entry.info.template !== null}<span class="mkind">from {entry.info.template}</span>{/if}
          <span class="spacer"></span>
          <button class="btn slim" type="button" disabled={busy} onclick={() => onselectdash(entry.ref)}
            >Open</button
          >
          <button class="btn slim" type="button" disabled={busy} onclick={() => startRename(entry)}
            >Rename</button
          >
          <button class="btn slim" type="button" disabled={busy} onclick={() => duplicate(entry.ref)}
            >Duplicate</button
          >
          {#if entry.info.template !== null}
            <button class="btn slim" type="button" disabled={busy} onclick={() => reset(entry.ref)}
              >Reset</button
            >
          {/if}
          <button class="btn slim danger" type="button" disabled={busy} onclick={() => remove(entry)}
            >{confirmDelete === entry.ref ? deleteWarning(entry) : 'Delete'}</button
          >
        {/if}
      </div>
    {/if}
  {:else}
    <p class="widget-note">No saved dashboards for this scope yet — customizing a built-in creates one.</p>
  {/each}

  <div class="mrow new">
    <input
      class="mname-input"
      placeholder="New dashboard name"
      aria-label="New dashboard name"
      bind:value={newName}
      onkeydown={(event) => event.key === 'Enter' && create()}
    />
    <button
      class="btn slim"
      type="button"
      disabled={busy || newName.trim() === ''}
      onclick={create}>New empty dashboard</button
    >
  </div>
</Modal>

<style>
  .mrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }

  .mrow.new {
    border-bottom: 0;
    margin-top: 10px;
  }

  .mname {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mname-input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }

  .mkind {
    font-size: 11px;
    color: var(--muted);
  }

  .spacer {
    flex: 1;
  }

  .danger {
    color: var(--bad);
  }
</style>
