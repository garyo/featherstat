<script lang="ts">
import type { QueryResponse } from '@analytics/shared';
import { type SharePayload, shareEndpoint } from '../lib/share.ts';
import { toggleTheme } from '../lib/theme.ts';
import DashboardGrid from '../views/DashboardGrid.svelte';
import { bucketedWindow } from '../widgets/format.ts';

/**
 * The read-only page behind a share link (docs/04 § 5). It carries no session,
 * so it holds none of the app's session-shaped machinery: no admin client, no
 * query client, no filter or range controls — one fetch of the share endpoint,
 * which returns the stored layout and its batch already assembled server-side.
 *
 * Live updates are intentionally absent. Realtime is `/api/realtime`, a
 * session-gated SSE stream, and a share token unlocks exactly one dashboard's
 * batch — nothing this page could subscribe to. A shared dashboard is a
 * snapshot; reloading re-runs the batch.
 */
interface Props {
  token: string;
}

let { token }: Props = $props();

let payload = $state<SharePayload | undefined>(undefined);
let error = $state<string | undefined>(undefined);

// One fetch, at mount: the token never changes for the life of the page.
void load();

async function load(): Promise<void> {
  try {
    const response = await fetch(shareEndpoint(token), { headers: { accept: 'application/json' } });
    if (!response.ok) {
      // Unknown, revoked and malformed answer identically by design — say the
      // one thing that is true of all three.
      error =
        response.status === 404
          ? 'This share link is no longer valid. Ask whoever sent it for a new one.'
          : 'This shared dashboard could not be loaded.';
      return;
    }
    payload = (await response.json()) as SharePayload;
    document.title = `${payload.dashboard.name} · shared`;
  } catch {
    error = 'This shared dashboard could not be loaded.';
  }
}

const response = $derived<QueryResponse | undefined>(
  payload === undefined ? undefined : { results: payload.results, meta: payload.meta },
);
const window = $derived(bucketedWindow(response));
</script>

<main class="shell">
  <header class="top">
    <div class="wordmark">Analytics<span class="dot">.</span></div>
    <div class="spacer"></div>
    <span class="compare-note">Shared dashboard · read-only</span>
    <button
      class="icon-btn"
      type="button"
      title="Toggle light/dark"
      aria-label="Toggle light or dark theme"
      onclick={toggleTheme}>◐</button
    >
  </header>

  {#if error !== undefined}
    <div class="card"><p class="widget-note">{error}</p></div>
  {:else if payload === undefined}
    <div class="card"><p class="widget-note">Loading…</p></div>
  {:else}
    <div class="filters">
      <span class="compare-note">{payload.dashboard.name}</span>
    </div>
    <DashboardGrid
      dashboard={payload.dashboard}
      {response}
      error={undefined}
      refetching={false}
      {window}
      chrome={false}
    />
  {/if}
</main>
