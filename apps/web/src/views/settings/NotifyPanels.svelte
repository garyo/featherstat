<script lang="ts">
import { BaseDimensionSchema, MetricSchema, type SiteInfo } from '@featherstat/shared';
import type { AdminClient } from '../../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../../lib/admin-failure.ts';
import { adminObjects } from '../../lib/admin-objects.ts';
import { type AlertDraft, draftsOf, emptyAlert, rulesOf } from '../../lib/alerts.ts';
import { createLoader } from '../../lib/loader.svelte.ts';
import { edited } from '../../lib/settings.ts';
import NtfyPanel from '../NtfyPanel.svelte';
import LoadState from './LoadState.svelte';
import PanelError from './PanelError.svelte';

/**
 * The Notifications panels: the ntfy endpoint + per-hit rules (NtfyPanel, docs/01
 * R16), and the alert rules evaluated hourly against the query engine (docs/04
 * § 5) — both deliver through the same ntfy endpoint, which is why they share
 * a section.
 */
interface Props {
  admin: AdminClient;
  sites: SiteInfo[] | undefined;
}

let { admin, sites }: Props = $props();
// svelte-ignore state_referenced_locally
const api = adminObjects(admin);

let drafts = $state<AlertDraft[]>([]);
let ntfy = $state<ReturnType<typeof NtfyPanel> | undefined>(undefined);
const rules = createLoader(() => api.alertRules(), {
  onload: (stored) => {
    drafts = draftsOf(stored);
  },
});
void rules.load();
let busy = $state(false);
let saved = $state(false);
/** `row` points the message at the rule that caused it; the rest is a panel failure. */
let error = $state<(PanelFailure & { row?: number }) | undefined>(undefined);

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  error = undefined;
  saved = false;
  const parsed = rulesOf(drafts);
  if ('error' in parsed) {
    error = { message: parsed.error, row: parsed.row, urgent: false };
    return;
  }
  busy = true;
  try {
    rules.set(await api.saveAlertRules(parsed.rules));
    saved = true;
  } catch (failure) {
    error = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    busy = false;
  }
}

/** Edits a Settings section switch would discard — here or in the ntfy card. */
export function unsaved(): boolean {
  const stored = rules.value;
  return (ntfy?.unsaved() ?? false) || (stored !== undefined && edited(drafts, draftsOf(stored)));
}
</script>

<NtfyPanel bind:this={ntfy} {admin} {sites} />

<div class="card c12">
  <h2>Alert rules</h2>
  <p class="widget-note">
    Checked hourly against the query engine; a firing rule notifies through the ntfy endpoint
    above, so configure that first. <code>moves more than</code> compares percent change against
    the same-length previous window.
  </p>
  <LoadState of={rules} what="Alert rules">
    {#snippet children()}
      <form class="oform" onsubmit={save}>
        {#each drafts as draft, index (index)}
          <div class="arow">
            <label class="field">
              Site
              <select bind:value={draft.site}>
                <option value="" disabled>pick one</option>
                {#each sites ?? [] as site (site.id)}
                  <option value={String(site.id)}>{site.name}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              Metric
              <select bind:value={draft.metric}>
                {#each MetricSchema.options as metric (metric)}
                  <option value={metric}>{metric}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              Where (optional)
              <input bind:value={draft.dim} list="alert-dims" placeholder="dimension" />
            </label>
            <label class="field">
              equals
              <input bind:value={draft.value} placeholder="value" />
            </label>
            <label class="field">
              Condition
              <select bind:value={draft.condition}>
                <option value="above">above</option>
                <option value="below">below</option>
                <option value="delta_pct">moves more than %</option>
              </select>
            </label>
            <label class="field thr">
              Threshold
              <input bind:value={draft.threshold} inputmode="decimal" placeholder="100" />
            </label>
            <label class="field">
              Window
              <select bind:value={draft.window}>
                <option value="day">today so far</option>
                <option value="hour">last 24 hours</option>
              </select>
            </label>
            <button
              class="btn subtle drop"
              type="button"
              aria-label="Remove alert rule {index + 1}"
              onclick={() => (drafts = drafts.filter((_, i) => i !== index))}>×</button
            >
          </div>
          {#if error?.row === index}
            <p class="form-error" role="alert">Rule {index + 1}: {error.message}</p>
          {/if}
        {:else}
          <p class="widget-note">No alert rules — nothing is watched.</p>
        {/each}
        <datalist id="alert-dims">
          {#each BaseDimensionSchema.options as dim (dim)}<option value={dim}></option>{/each}
        </datalist>
        <button
          class="btn addv"
          type="button"
          onclick={() => (drafts = [...drafts, emptyAlert(sites?.[0]?.id)])}
        >
          Add alert rule
        </button>
        {#if error?.row === undefined}
          <PanelError failure={error} />
        {/if}
        {#if saved}<p class="form-ok" role="status">Alert rules saved.</p>{/if}
        <div class="row">
          <button class="btn primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save alert rules'}
          </button>
        </div>
      </form>
    {/snippet}
  </LoadState>
</div>

<style>
  .oform {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .arow {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px;
  }

  .arow .field {
    flex: 1 1 130px;
    min-width: 0;
  }

  .arow .thr {
    flex: 0 1 100px;
  }

  .drop {
    flex: 0 0 auto;
    padding: 6px 10px;
  }

  .addv {
    align-self: flex-start;
  }

  .row {
    display: flex;
    gap: 8px;
  }
</style>
