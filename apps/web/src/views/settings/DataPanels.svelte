<script lang="ts">
import type {
  AdminDiagnostics,
  AdminPropsResponse,
  AnnotationInfo,
  SiteInfo,
} from '@featherstat/shared';
import type { AdminClient } from '../../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../../lib/admin-failure.ts';
import { adminObjects } from '../../lib/admin-objects.ts';
import { botDropTotals, formatBytes, localInputToMs, msToLocalInput } from '../../lib/settings.ts';
import { exactNumber } from '../../widgets/format.ts';
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
const nameOf = (id: number): string => sites?.find((s) => s.id === id)?.name ?? `Site ${id}`;

// ---------- props governance ----------
let propSite = $state<number | undefined>(undefined);
const propSiteId = $derived(propSite ?? sites?.[0]?.id);
let propStats = $state<AdminPropsResponse | undefined>(undefined);
let propsFailed = $state(false);
let propError = $state<PanelFailure | undefined>(undefined);
/** The key whose delete is awaiting the second, explicit click. */
let confirming = $state<string | undefined>(undefined);

$effect(() => {
  if (propSiteId === undefined) return;
  propStats = undefined;
  confirming = undefined;
  void api
    .props(propSiteId)
    .then((response) => {
      propStats = response;
    })
    .catch(() => {
      propsFailed = true;
    });
});

async function deleteKey(key: string): Promise<void> {
  if (propSiteId === undefined) return;
  propError = undefined;
  try {
    await api.deletePropKey(propSiteId, key);
    confirming = undefined;
    propStats = await api.props(propSiteId);
  } catch (failure) {
    propError = panelFailure(failure, 'Deleting failed — try again.');
  }
}

const dropTotal = $derived(
  propStats === undefined ? 0 : propStats.drops.reduce((sum, drop) => sum + drop.count, 0),
);

// ---------- annotations ----------
let annotations = $state<AnnotationInfo[] | undefined>(undefined);
let annFailed = $state(false);
let annOpen = $state(false);
let annEditing = $state<number | undefined>(undefined);
let annDraft = $state({ site: '', when: '', text: '' });
let annBusy = $state(false);
let annError = $state<PanelFailure | undefined>(undefined);
/** The row verbs report beside the rows; the form has its own line. */
let annRowError = $state<PanelFailure | undefined>(undefined);

const loadAnnotations = (): Promise<void> =>
  api
    .listAnnotations()
    .then((list) => {
      annotations = list;
    })
    .catch(() => {
      annFailed = true;
    });
$effect(() => {
  void loadAnnotations();
});

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
    await loadAnnotations();
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
    await loadAnnotations();
  } catch (failure) {
    annRowError = panelFailure(failure, 'Deleting failed — try again.');
  }
}

// ---------- data settings (retention + backup) ----------
let dsLoaded = $state(false);
let dsFailed = $state(false);
let dsDraft = $state({ retention: '', backupDir: '', backupKeep: '7' });
let dsBusy = $state(false);
let dsSaved = $state(false);
let dsError = $state<PanelFailure | undefined>(undefined);

$effect(() => {
  void api
    .dataSettings()
    .then((settings) => {
      dsDraft = {
        retention: settings.retentionDays === null ? '' : String(settings.retentionDays),
        backupDir: settings.backupDir ?? '',
        backupKeep: String(settings.backupKeep),
      };
      dsLoaded = true;
    })
    .catch(() => {
      dsFailed = true;
    });
});

async function saveDataSettings(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  dsBusy = true;
  dsError = undefined;
  dsSaved = false;
  try {
    const saved = await api.saveDataSettings({
      retentionDays: dsDraft.retention.trim() === '' ? null : Number(dsDraft.retention),
      backupDir: dsDraft.backupDir.trim() === '' ? null : dsDraft.backupDir.trim(),
      backupKeep: dsDraft.backupKeep.trim() === '' ? 7 : Number(dsDraft.backupKeep),
    });
    dsDraft = {
      retention: saved.retentionDays === null ? '' : String(saved.retentionDays),
      backupDir: saved.backupDir ?? '',
      backupKeep: String(saved.backupKeep),
    };
    dsSaved = true;
  } catch (failure) {
    dsError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    dsBusy = false;
  }
}

// ---------- diagnostics ----------
let diagnostics = $state<AdminDiagnostics | undefined>(undefined);
let diagnosticsError = $state(false);
$effect(() => {
  void admin
    .diagnostics()
    .then((result) => {
      diagnostics = result;
    })
    .catch(() => {
      diagnosticsError = true;
    });
});

const botTotals = $derived(diagnostics === undefined ? [] : botDropTotals(diagnostics.botDrops));
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
  {#if propsFailed}
    <p class="widget-note">Props unavailable.</p>
  {:else if propStats === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each propStats.keys as key (key.key)}
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
        {#if confirming === key.key}
          <button class="btn subtle danger" type="button" onclick={() => void deleteKey(key.key)}>
            Really delete + scrub
          </button>
          <button class="btn subtle" type="button" onclick={() => (confirming = undefined)}>
            Keep
          </button>
        {:else}
          <button class="btn subtle" type="button" onclick={() => (confirming = key.key)}>
            Delete…
          </button>
        {/if}
      </div>
    {:else}
      <p class="widget-note">No props recorded for this site.</p>
    {/each}
    <PanelError failure={propError} />
    {#if dropTotal > 0}
      <p class="widget-note">
        {exactNumber(dropTotal)} prop values clamped in the last 7 days:
        {propStats.drops.map((drop) => `${drop.reason} ×${drop.count}`).join(', ')}.
      </p>
    {/if}
  {/if}
</div>

<div class="card c6">
  <h2>Annotations</h2>
  <p class="widget-note">
    Notes pinned to a moment — a deploy, a post, an outage — drawn as markers on every time series
    that covers it.
  </p>
  {#if annFailed}
    <p class="widget-note">Annotations unavailable.</p>
  {:else if annotations === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each annotations as info (info.id)}
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
        <button class="btn subtle" type="button" onclick={() => void deleteAnnotation(info.id)}>
          Delete
        </button>
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
  {/if}
</div>

<div class="card c6">
  <h2>Retention &amp; backups</h2>
  <p class="widget-note">
    Raw events older than the retention window are pruned nightly (rollup summaries stay). Naming a
    backup directory turns on a nightly <code>VACUUM INTO</code> copy of the database, kept to the
    newest N files.
  </p>
  {#if dsFailed}
    <p class="widget-note">Data settings unavailable.</p>
  {:else if !dsLoaded}
    <p class="widget-note">Loading…</p>
  {:else}
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
        <input type="number" min="1" max="365" bind:value={dsDraft.backupKeep} />
      </label>
      <PanelError failure={dsError} />
      {#if dsSaved}<p class="form-ok">Saved.</p>{/if}
      <div class="row">
        <button class="btn primary" type="submit" disabled={dsBusy}>
          {dsBusy ? 'Saving…' : 'Save data settings'}
        </button>
      </div>
    </form>
  {/if}
</div>

<div class="card c6">
  <h2>Diagnostics</h2>
  {#if diagnosticsError}
    <p class="widget-note">Diagnostics unavailable.</p>
  {:else if diagnostics === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    <dl class="diag">
      <div><dt>Database size</dt><dd>{formatBytes(diagnostics.dbSizeBytes)}</dd></div>
      <div><dt>Stored events</dt><dd>{exactNumber(diagnostics.eventCount)}</dd></div>
      <div>
        <dt>Bot hits dropped · 7 days</dt>
        <dd>{exactNumber(botTotals.reduce((sum, [, count]) => sum + count, 0))}</dd>
      </div>
    </dl>
    {#if botTotals.length > 0}
      <div class="bot-list">
        {#each botTotals as [siteId, count] (siteId)}
          <div class="bot-row">
            <span class="name">{nameOf(siteId)}</span>
            <span class="num">{exactNumber(count)}</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
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
