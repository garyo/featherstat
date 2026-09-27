<script lang="ts">
import type { Dashboard } from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import ConfirmButton from '../lib/components/ConfirmButton.svelte';
import Modal from '../lib/components/Modal.svelte';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import { shareLink } from '../lib/share.ts';
import type { DashRef } from '../lib/state.ts';

/**
 * Mint / copy / revoke for a dashboard's share links (docs/04 § 5).
 *
 * A link points at a STORED dashboard, so sharing a dashboard that is still the
 * shipped default saves it first — the layout on screen becomes row one, and
 * the link then follows every later edit. The view then moves onto that row, as
 * it does after the editor's first save: left on the built-in, the next share
 * would clone it again.
 *
 * Only the sha256 of a token is stored, and the raw token is returned exactly
 * once at mint time: the admin API can therefore neither list links nor show an
 * old one again. What this panel lists is what it minted in this session; what
 * it revokes is all of them at once, which is the whole of what the API offers.
 */
interface Props {
  admin: AdminClient;
  store: DashboardStore;
  /** The layout to persist if this dashboard has no row yet — scope already applied. */
  layout: Dashboard;
  /** Points the view at the row a first share just created. */
  onselectdash?: (dash: DashRef) => void;
  onclose: () => void;
}

let { admin, store, layout, onselectdash, onclose }: Props = $props();

interface MintedLink {
  token: string;
  url: string;
  /** Copied at least once — a link that never was is lost when the dialog closes. */
  copied: boolean;
}

let links = $state<MintedLink[]>([]);
let busy = $state(false);
let error = $state<string | undefined>(undefined);
let revoked = $state<number | undefined>(undefined);
/** Revoking is destructive and unenumerable — the armed button explains it first. */
let confirmRevoke = $state(false);
/** The row this dialog created, held while the store reloads onto it. */
let created = $state<number | undefined>(undefined);
const rowId = $derived(store.id ?? created);

async function mint(): Promise<void> {
  busy = true;
  error = undefined;
  revoked = undefined;
  try {
    const id = await dashboardId();
    const { token } = await admin.createShareLink(id);
    links = [{ token, url: shareLink(window.location.origin, token), copied: false }, ...links];
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Creating the link failed — try again.';
  } finally {
    busy = false;
  }
}

async function revokeAll(): Promise<void> {
  busy = true;
  error = undefined;
  try {
    const id = await dashboardId();
    const result = await admin.revokeShareLinks(id);
    revoked = result.revoked;
    links = [];
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Revoking failed — try again.';
  } finally {
    busy = false;
  }
}

/** The row a link points at, creating it from the current layout on first share. */
async function dashboardId(): Promise<number> {
  if (rowId !== undefined) return rowId;
  await store.save(layout);
  const id = store.id;
  if (id === undefined) throw new Error(store.error ?? 'Saving the dashboard failed.');
  created = id;
  onselectdash?.(id);
  return id;
}

/** A link is shown once: closing before it was copied loses it for good. */
function mayClose(): boolean {
  return (
    links.every((link) => link.copied) ||
    window.confirm('Close without copying the new share link? It cannot be shown again.')
  );
}

async function copy(link: MintedLink): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.url);
    link.copied = true;
  } catch {
    // Clipboard needs a secure context (plain-http deploys reject) — say so
    // rather than failing silently; the link is selectable in the field.
    error = 'Copying failed — select the link and copy it manually.';
  }
}
</script>

<Modal title="Share this dashboard" {onclose} onrequestclose={mayClose}>
  <p class="widget-note">
    A share link opens this dashboard read-only, without a login. It answers only this
    dashboard's own queries — never the rest of your data — and shows no live updates.
  </p>

  {#if rowId === undefined}
    <p class="widget-note">
      This dashboard is still the built-in default. Creating a link saves the current layout
      first, so the link has something to point at.
    </p>
  {/if}

  {#each links as link (link.token)}
    <div class="link">
      <input class="url" readonly value={link.url} aria-label="Share link" />
      <button class="btn" type="button" onclick={() => void copy(link)}>
        {link.copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  {:else}
    <p class="widget-note">No links created in this session.</p>
  {/each}

  {#if links.length > 0}
    <p class="widget-note">
      Copy it now — a link is shown once. The server keeps only its fingerprint, so it can be
      revoked but never shown again.
    </p>
  {/if}

  {#if error !== undefined}<p class="form-error" role="alert">{error}</p>{/if}
  {#if revoked !== undefined}
    <p class="form-ok">
      {revoked === 0 ? 'There were no active links.' : `${revoked} link(s) revoked.`}
    </p>
  {/if}

  {#if confirmRevoke}
    <p class="widget-note" role="alert">
      This revokes every link ever created for this dashboard — including ones not listed here —
      and cannot be undone.
    </p>
  {/if}

  <div class="row">
    <button class="btn primary" type="button" disabled={busy} onclick={() => void mint()}>
      {busy ? 'Working…' : 'Create share link'}
    </button>
    <ConfirmButton
      class="btn"
      label="Revoke all links"
      confirm="Really revoke all links?"
      disabled={busy || rowId === undefined}
      bind:armed={confirmRevoke}
      onconfirm={revokeAll}
    />
  </div>
</Modal>

<style>
  .link {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .url {
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }

  .row {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
</style>
