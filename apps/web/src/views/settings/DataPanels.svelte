<script lang="ts">
import type { AnnotationInfo, ExclusionRule, SiteInfo } from '@featherstat/shared';
import type { AdminClient } from '../../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../../lib/admin-failure.ts';
import { adminObjects } from '../../lib/admin-objects.ts';
import ConfirmButton from '../../lib/components/ConfirmButton.svelte';
import { createLoader } from '../../lib/loader.svelte.ts';
import {
  type DataSettingsDraft,
  dataSettingsBody,
  dataSettingsDraft,
  dropTotals,
  formatBytes,
  localInputToMs,
  msToLocalInput,
} from '../../lib/settings.ts';
import { exactNumber } from '../../widgets/format.ts';
import LoadState from './LoadState.svelte';
import PanelError from './PanelError.svelte';

/**
 * The Data panels: custom-prop governance (docs/03 § Props — key stats, what
 * ingest clamped, and the delete that scrubs history), annotations (docs/04
 * § 5 — the notes timeseries widgets mark), and the storage diagnostics.
 */
interface Props {
  admin: AdminClient;
  sites: SiteInfo[] | undefined;
}

let { admin, sites }: Props = $props();
// svelte-ignore state_referenced_locally
const api = adminObjects(admin);
const totalOf = (rows: Array<[number, number]>): number =>
  rows.reduce((sum, [, count]) => sum + count, 0);
const nameOf = (id: number): string => sites?.find((s) => s.id === id)?.name ?? `Site ${id}`;

// ---------- props governance ----------
let propSite = $state<number | undefined>(undefined);
const propSiteId = $derived(propSite ?? sites?.[0]?.id);
const propStats = createLoader((site: number) => api.props(site));
let propError = $state<PanelFailure | undefined>(undefined);

$effect(() => {
  if (propSiteId !== undefined) void propStats.load(propSiteId);
});

async function deleteKey(key: string): Promise<void> {
  if (propSiteId === undefined) return;
  propError = undefined;
  try {
    await api.deletePropKey(propSiteId, key);
    await propStats.reload();
  } catch (failure) {
    propError = panelFailure(failure, 'Deleting failed — try again.');
  }
}

const dropTotal = $derived(
  (propStats.value?.drops ?? []).reduce((sum, drop) => sum + drop.count, 0),
);

// ---------- annotations ----------
const annotations = createLoader(() => api.listAnnotations());
void annotations.load();
let annOpen = $state(false);
let annEditing = $state<number | undefined>(undefined);
let annDraft = $state({ site: '', when: '', text: '' });
let annBusy = $state(false);
let annError = $state<PanelFailure | undefined>(undefined);
/** The row verbs report beside the rows; the form has its own line. */
let annRowError = $state<PanelFailure | undefined>(undefined);

function openAnnotation(info?: AnnotationInfo): void {
  annOpen = true;
  annEditing = info?.id;
  annError = undefined;
  annDraft = {
    site: info?.siteId == null ? '' : String(info.siteId),
    when: msToLocalInput(info?.ts ?? Date.now()),
    text: info?.text ?? '',
  };
}

async function saveAnnotation(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const ts = localInputToMs(annDraft.when);
  if (ts === undefined) {
    annError = { message: 'pick a date and time', urgent: false };
    return;
  }
  annBusy = true;
  annError = undefined;
  try {
    const body = {
      siteId: annDraft.site === '' ? null : Number(annDraft.site),
      ts,
      text: annDraft.text.trim(),
    };
    if (annEditing === undefined) await api.createAnnotation(body);
    else await api.updateAnnotation(annEditing, body);
    annOpen = false;
    await annotations.reload();
  } catch (failure) {
    annError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    annBusy = false;
  }
}

async function deleteAnnotation(id: number): Promise<void> {
  annRowError = undefined;
  try {
    await api.deleteAnnotation(id);
    await annotations.reload();
  } catch (failure) {
    annRowError = panelFailure(failure, 'Deleting failed — try again.');
  }
}

// ---------- data settings (retention + backup) ----------
let dsDraft = $state<DataSettingsDraft>({ retention: null, backupDir: '', backupKeep: null });
const dataSettings = createLoader(() => api.dataSettings(), {
  onload: (settings) => {
    dsDraft = dataSettingsDraft(settings);
  },
});
void dataSettings.load();
let dsBusy = $state(false);
let dsSaved = $state(false);
let dsError = $state<PanelFailure | undefined>(undefined);

async function saveDataSettings(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  dsError = undefined;
  dsSaved = false;
  const parsed = dataSettingsBody(dsDraft);
  if ('error' in parsed) {
    dsError = { message: parsed.error, urgent: false };
    return;
  }
  dsBusy = true;
  try {
    dataSettings.set(await api.saveDataSettings(parsed.body));
    dsSaved = true;
  } catch (failure) {
    dsError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    dsBusy = false;
  }
}

// ---------- diagnostics ----------
const diagnostics = createLoader(() => admin.diagnostics());
void diagnostics.load();

// ---------- traffic exclusion ----------
let xError = $state<PanelFailure | undefined>(undefined);
let xBusy = $state(false);
/** The rows being edited — the panel is a form over a full-list replace. */
let xDraft = $state<ExclusionRule[]>([]);
const exclusions = createLoader(() => admin.exclusions(), {
  onload: (state) => {
    xDraft = state.rules.map((rule) => ({ ...rule }));
  },
});
void exclusions.load();

const resolutionOf = (value: string) =>
  exclusions.value?.resolutions.find((r) => r.value === value);

async function saveExclusions(): Promise<void> {
  xError = undefined;
  xBusy = true;
  try {
    // Blank rows are how a row is deleted, so they are dropped rather than sent.
    const rules = xDraft.filter((rule) => rule.value.trim() !== '');
    exclusions.set(await admin.saveExclusions(rules));
  } catch (failure) {
    xError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    xBusy = false;
  }
}
</script>

<div class="card c6">
  <h2>Custom props</h2>
  <p class="widget-note">
    The prop keys this site's tracker has sent, queryable as <code>prop:&lt;key&gt;</code>.
    Deleting a key also scrubs it from every stored event — that history does not come back.
  </p>
  <label class="field psite">
    Site
    <select
      value={String(propSiteId ?? '')}
      onchange={(e) => (propSite = Number(e.currentTarget.value))}
    >
      {#each sites ?? [] as site (site.id)}
        <option value={String(site.id)}>{site.name}</option>
      {/each}
    </select>
  </label>
  <LoadState of={propStats} what="Props">
    {#snippet children(stats)}
      {#each stats.keys as key (key.key)}
        <div class="prow">
          <div class="pmeta">
            <span class="pname">
              {key.key}{key.overCapSince === null ? '' : ' · over the value cap'}
            </span>
            <span class="psub">
              {exactNumber(key.events)} events · {exactNumber(key.distinctValues)} values · last seen
              {new Date(key.lastSeen).toLocaleDateString()}
            </span>
          </div>
          <ConfirmButton
            label="Delete…"
            confirm="Really delete + scrub"
            pending="Scrubbing…"
            onconfirm={() => deleteKey(key.key)}
          />
        </div>
      {:else}
        <p class="widget-note">No props recorded for this site.</p>
      {/each}
      <PanelError failure={propError} />
      {#if dropTotal > 0}
        <p class="widget-note">
          {exactNumber(dropTotal)} prop values clamped in the last 7 days:
          {stats.drops.map((drop) => `${drop.reason} ×${drop.count}`).join(', ')}.
        </p>
      {/if}
    {/snippet}
  </LoadState>
</div>

<div class="card c6">
  <h2>Annotations</h2>
  <p class="widget-note">
    Notes pinned to a moment — a deploy, a post, an outage — drawn as markers on every time series
    that covers it.
  </p>
  <LoadState of={annotations} what="Annotations">
    {#snippet children(list)}
      {#each list as info (info.id)}
        <div class="prow">
          <div class="pmeta">
            <span class="pname">{info.text}</span>
            <span class="psub">
              {new Date(info.ts).toLocaleString()} · {info.siteId === null
                ? 'every site'
                : nameOf(info.siteId)}
            </span>
          </div>
          <button class="btn subtle" type="button" onclick={() => openAnnotation(info)}>Edit</button>
          <ConfirmButton
            label="Delete"
            confirm="Really delete?"
            pending="Deleting…"
            onconfirm={() => deleteAnnotation(info.id)}
          />
        </div>
      {:else}
        <p class="widget-note">No annotations yet.</p>
      {/each}
      <PanelError failure={annRowError} />
      {#if annOpen}
        <form class="oform" onsubmit={saveAnnotation}>
          <div class="wrap">
            <label class="field">
              Site
              <select bind:value={annDraft.site}>
                <option value="">Every site</option>
                {#each sites ?? [] as site (site.id)}
                  <option value={String(site.id)}>{site.name}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              When
              <input type="datetime-local" bind:value={annDraft.when} required />
            </label>
          </div>
          <label class="field">
            Note (300 characters)
            <input bind:value={annDraft.text} maxlength="300" required />
          </label>
          <PanelError failure={annError} />
          <div class="row">
            <button
              class="btn primary"
              type="submit"
              disabled={annBusy || annDraft.text.trim() === ''}
            >
              {annBusy ? 'Saving…' : 'Save annotation'}
            </button>
            <button class="btn" type="button" onclick={() => (annOpen = false)}>Cancel</button>
          </div>
        </form>
      {:else}
        <button class="btn addv" type="button" onclick={() => openAnnotation()}>New annotation</button>
      {/if}
    {/snippet}
  </LoadState>
</div>

<div class="card c6">
  <h2>Retention &amp; backups</h2>
  <p class="widget-note">
    Raw events older than the retention window are pruned nightly (rollup summaries stay). Naming a
    backup directory turns on a nightly <code>VACUUM INTO</code> copy of the database, kept to the
    newest N files.
  </p>
  <LoadState of={dataSettings} what="Data settings">
    {#snippet children()}
      <form class="oform" onsubmit={saveDataSettings}>
        <label class="field">
          Keep raw events for (days — empty keeps everything forever)
          <input type="number" min="1" bind:value={dsDraft.retention} placeholder="forever" />
        </label>
        <label class="field">
          Backup directory (empty = backups off)
          <input bind:value={dsDraft.backupDir} placeholder="/data/backups" />
        </label>
        <label class="field">
          Backups to keep
          <input type="number" min="1" max="365" bind:value={dsDraft.backupKeep} required />
        </label>
        <PanelError failure={dsError} />
        {#if dsSaved}<p class="form-ok">Saved.</p>{/if}
        <div class="row">
          <button class="btn primary" type="submit" disabled={dsBusy}>
            {dsBusy ? 'Saving…' : 'Save data settings'}
          </button>
        </div>
      </form>
    {/snippet}
  </LoadState>
</div>

<div class="card c6">
  <h2>Diagnostics</h2>
  <LoadState of={diagnostics} what="Diagnostics">
    {#snippet children(stats)}
      {@const botTotals = dropTotals(stats.botDrops)}
      {@const excludedTotals = dropTotals(stats.excludedDrops)}
      <dl class="diag">
        <div><dt>Database size</dt><dd>{formatBytes(stats.dbSizeBytes)}</dd></div>
        <div><dt>Stored events</dt><dd>{exactNumber(stats.eventCount)}</dd></div>
        <div>
          <dt>Bot hits dropped · 7 days</dt>
          <dd>{exactNumber(totalOf(botTotals))}</dd>
        </div>
        <div>
          <dt>Excluded hits · 7 days</dt>
          <dd>{exactNumber(totalOf(excludedTotals))}</dd>
        </div>
      </dl>
      {#if botTotals.length > 0}
        <p class="widget-note">Bot drops by site</p>
        {@render dropList(botTotals)}
      {/if}
      {#if excludedTotals.length > 0}
        <p class="widget-note">Excluded by site</p>
        {@render dropList(excludedTotals)}
      {/if}
    {/snippet}
  </LoadState>
</div>

{#snippet dropList(rows: Array<[number, number]>)}
  <div class="bot-list">
    {#each rows as [siteId, count] (siteId)}
      <div class="bot-row">
        <span class="name">{nameOf(siteId)}</span>
        <span class="num">{exactNumber(count)}</span>
      </div>
    {/each}
  </div>
{/snippet}

<div class="card c6">
  <h2>Excluded traffic</h2>
  <p class="widget-note">
    Hits from these addresses are dropped at ingest and counted, never stored. Enter an IP, a
    range like <code>198.51.100.0/24</code>, or a hostname — hostnames re-resolve every few
    minutes, so they suit a dynamic address.
  </p>
  <LoadState of={exclusions} what="Rules">
    {#snippet children()}
      <PanelError failure={xError} />
      {#each xDraft as rule, i (i)}
        {@const resolution = resolutionOf(rule.value)}
        <div class="xrow">
          <input
            class="xvalue"
            placeholder="IP, range, or hostname"
            aria-label="Excluded address {i + 1}"
            bind:value={rule.value}
          />
          <input
            class="xnote"
            placeholder="note"
            aria-label="Note for excluded address {i + 1}"
            bind:value={rule.note}
          />
          <button
            class="btn subtle danger"
            type="button"
            aria-label="Remove excluded address {i + 1}"
            onclick={() => (xDraft = xDraft.filter((_, at) => at !== i))}
          >
            Remove
          </button>
        </div>
        {#if resolution !== undefined}
          <p class="xres" class:bad={resolution.error !== null}>
            {#if resolution.error !== null}
              Lookup failed: {resolution.error}{resolution.addresses.length > 0
                ? ` — still matching ${resolution.addresses.join(', ')}`
                : ' — matching nothing'}
            {:else if resolution.addresses.length > 0}
              Resolves to {resolution.addresses.join(', ')}
            {:else}
              Not resolved yet.
            {/if}
          </p>
        {/if}
      {/each}
      <div class="xrow">
        <button
          class="btn subtle"
          type="button"
          onclick={() => (xDraft = [...xDraft, { value: '', note: '' }])}
        >
          Add
        </button>
        <button class="btn" type="button" disabled={xBusy} onclick={() => void saveExclusions()}>
          {xBusy ? 'Saving…' : 'Save'}
        </button>
      </div>
    {/snippet}
  </LoadState>
</div>

<style>
  .prow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--grid);
  }

  .pmeta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .pname {
    font-weight: 600;
  }

  .psub {
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .danger {
    color: var(--bad);
  }

  .oform {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .wrap .field {
    flex: 1 1 180px;
    min-width: 0;
  }

  .row {
    display: flex;
    gap: 8px;
  }

  .addv {
    margin-top: 12px;
  }

  .psite {
    max-width: 240px;
    margin-bottom: 10px;
  }

  .diag {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .diag div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .diag dt {
    color: var(--ink-2);
  }

  .diag dd {
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .xrow {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 0;
  }

  .xvalue,
  .xnote {
    flex: 1 1 0;
    min-width: 0;
  }

  .xvalue {
    flex-grow: 2;
  }

  .xres {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--muted);
  }

  .xres.bad {
    color: var(--bad);
  }

  .bot-list {
    margin-top: 10px;
    border-top: 1px solid var(--grid);
    padding-top: 6px;
  }

  .bot-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12.5px;
    padding: 3px 0;
  }

  .bot-row .name {
    color: var(--ink-2);
  }

  .bot-row .num {
    font-variant-numeric: tabular-nums;
  }
</style>
