<script lang="ts">
import type { Dashboard } from '@analytics/shared';
import Modal from '../editor/Modal.svelte';
import type { AdminClient } from '../lib/admin.ts';
import type { DashboardStore } from '../lib/dashboards.svelte.ts';
import { shareLink } from '../lib/share.ts';

/**
 * Mint / copy / revoke for a dashboard's share links (docs/04 § 5).
 *
 * A link points at a STORED dashboard, so sharing a dashboard that is still the
 * shipped default saves it first — the layout on screen becomes row one, and
 * the link then follows every later edit.
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
  onclose: () => void;
}

let { admin, store, layout, onclose }: Props = $props();

interface MintedLink {
  token: string;
  url: string;
}

let links = $state<MintedLink[]>([]);
let busy = $state(false);
let error = $state<string | undefined>(undefined);
let revoked = $state<number | undefined>(undefined);
let copied = $state<string | undefined>(undefined);
/** Revoking is destructive and unenumerable — it takes a second, armed click. */
let confirmRevoke = $state(false);

async function mint(): Promise<void> {
  busy = true;
  error = undefined;
  revoked = undefined;
  confirmRevoke = false;
  try {
    const id = await dashboardId();
    const { token } = await admin.createShareLink(id);
    links = [{ token, url: shareLink(window.location.origin, token) }, ...links];
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Creating the link failed — try again.';
  } finally {
    busy = false;
  }
}

async function revokeAll(): Promise<void> {
  if (!confirmRevoke) {
    confirmRevoke = true;
    return;
  }
  confirmRevoke = false;
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
  const existing = store.id;
  if (existing !== undefined) return existing;
  await store.save(layout);
  const created = store.id;
  if (created === undefined) throw new Error(store.error ?? 'Saving the dashboard failed.');
  return created;
}

async function copy(link: MintedLink): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.url);
    copied = link.token;
  } catch {
    // Clipboard needs a secure context (plain-http deploys reject) — say so
    // rather than failing silently; the link is selectable in the field.
    copied = undefined;
    error = 'Copying failed — select the link and copy it manually.';
  }
}
</script>

<Modal title="Share this dashboard" {onclose}>
  <p class="widget-note">
    A share link opens this dashboard read-only, without a login. It answers only this
    dashboard's own queries — never the rest of your data — and shows no live updates.
  </p>

  {#if store.id === undefined}
    <p class="widget-note">
      This dashboard is still the built-in default. Creating a link saves the current layout
      first, so the link has something to point at.
    </p>
  {/if}

  {#each links as link (link.token)}
    <div class="link">
      <input class="url" readonly value={link.url} aria-label="Share link" />
      <button class="btn" type="button" onclick={() => void copy(link)}>
        {copied === link.token ? 'Copied ✓' : 'Copy'}
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
    <button
      class="btn"
      type="button"
      disabled={busy || store.id === undefined}
      title={store.id === undefined ? 'Nothing is shared yet — this dashboard has no stored row' : undefined}
      onclick={() => void revokeAll()}
      >{confirmRevoke ? 'Really revoke all links?' : 'Revoke all links'}</button
    >
    {#if confirmRevoke}
      <button class="btn subtle" type="button" onclick={() => (confirmRevoke = false)}
        >Keep them</button
      >
    {/if}
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
