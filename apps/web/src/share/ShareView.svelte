<script lang="ts">
import { type QueryResponse, type SharePayload, SharePayloadSchema } from '@featherstat/shared';
import { shareEndpoint } from '../lib/share.ts';
import { parseViewState } from '../lib/state.ts';
import { toggleTheme } from '../lib/theme.ts';
import DashboardGrid from '../views/DashboardGrid.svelte';
import { dashboardEnv } from '../widgets/env.ts';
import { windowLabel } from '../widgets/format.ts';
import type { AppEnv } from '../widgets/types.ts';

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

/** `?range=` is the share endpoint's one client knob; the same parser the app
 * uses reads it, so `/s/<token>?range=7d` means here what it means there. The
 * endpoint takes PRESETS only (docs/04 § 5), so an explicit-date range — which
 * this page offers no control for — falls back to the endpoint's default. */
const parsedRange = parseViewState(window.location.href).range;
const range = typeof parsedRange === 'string' ? parsedRange : '30d';

/**
 * What this page can offer its widgets — and, said out loud, what it cannot. A
 * share link carries no session: no live stream, no site directory, nowhere to
 * navigate. Written as nulls rather than omitted, so the grid can render one
 * honest "no live stream here" instead of a realtime card claiming no visitors.
 */
const app: AppEnv = {
  now: Date.now(),
  realtime: null,
  sites: null,
  onopenrealtime: null,
  onselectsite: null,
};

// One fetch, at mount: the token never changes for the life of the page.
void load();

async function load(): Promise<void> {
  try {
    const response = await fetch(shareEndpoint(token, range), {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      // Unknown, revoked and malformed answer identically by design — say the
      // one thing that is true of all three.
      error =
        response.status === 404
          ? 'This share link is no longer valid. Ask whoever sent it for a new one.'
          : 'This shared dashboard could not be loaded.';
      return;
    }
    const parsed = SharePayloadSchema.safeParse(await response.json());
    if (!parsed.success) {
      error = 'This shared dashboard could not be loaded.';
      return;
    }
    payload = parsed.data;
    document.title = `${payload.dashboard.name} · shared`;
  } catch {
    error = 'This shared dashboard could not be loaded.';
  }
}

const response = $derived<QueryResponse | undefined>(
  payload === undefined ? undefined : { results: payload.results, meta: payload.meta },
);
/**
 * The range this page is showing, read off the same `meta.windows` the in-app
 * dashboard reads. A share page has no site directory and so cannot resolve a
 * preset; neither screen derives a window of its own, so the two agree by
 * construction through identical widget code.
 */
const span = $derived(windowLabel(payload?.meta.windows));
const env = $derived(
  dashboardEnv(app, {
    scope: payload?.dashboard.site ?? 'all',
    range,
    onfilter: null,
    ondrill: null,
    onpivot: null,
  }),
);
</script>

<main class="shell">
  <header class="top">
    <div class="wordmark">featherstat<span class="dot">.</span></div>
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
      <span class="compare-note"
        >{payload.dashboard.name}{span === undefined ? '' : ` · ${span}`}</span
      >
    </div>
    <DashboardGrid
      dashboard={payload.dashboard}
      {response}
      error={undefined}
      refetching={false}
      {env}
      chrome={false}
    />
  {/if}
</main>
