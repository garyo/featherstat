<script lang="ts">
import type { CampaignAlias, CampaignInfo, SiteInfo } from '@featherstat/shared';
import type { AdminClient } from '../../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../../lib/admin-failure.ts';
import { adminObjects } from '../../lib/admin-objects.ts';
import type { AuthRole } from '../../lib/auth.svelte.ts';
import {
  buildUtmUrl,
  emptyUtmDraft,
  missingUtmFields,
  normalizationWarnings,
  type UtmDraft,
} from '../../lib/utm-builder.ts';
import PanelError from './PanelError.svelte';

/**
 * The campaign panels (docs/03 § Campaigns): the registry `campaign_status`
 * reads at query time, the alias rows ingest rewrites with (an edit backfills
 * history — the server owns that job), and a client-only UTM link builder that
 * knows both, so a link is tagged the way this install will actually store it.
 */
interface Props {
  admin: AdminClient;
  sites: SiteInfo[] | undefined;
  /** Aliases rewrite history install-wide — admin-only. */
  role?: AuthRole;
}

let { admin, sites, role = 'admin' }: Props = $props();
// svelte-ignore state_referenced_locally
const api = adminObjects(admin);

// ---------- registry ----------
let regSite = $state<number | undefined>(undefined);
const regSiteId = $derived(regSite ?? sites?.[0]?.id);
let campaigns = $state<CampaignInfo[] | undefined>(undefined);
let regFailed = $state(false);
let regOpen = $state(false);
let regEditing = $state<number | undefined>(undefined);
let regDraft = $state({ name: '', sources: '', mediums: '', startsAt: '', endsAt: '', notes: '' });
let regBusy = $state(false);
let regError = $state<PanelFailure | undefined>(undefined);
/** A row's Delete reports beside the row — the editor form may not even be open. */
let regRowError = $state<PanelFailure | undefined>(undefined);

$effect(() => {
  if (regSiteId === undefined) return;
  campaigns = undefined;
  void api
    .listCampaigns(regSiteId)
    .then((list) => {
      campaigns = list;
    })
    .catch(() => {
      regFailed = true;
    });
});

const csv = (list: string[] | null): string => (list === null ? '' : list.join(', '));
const listOf = (text: string): string[] | null => {
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length === 0 ? null : entries;
};

function openCampaign(info?: CampaignInfo): void {
  regOpen = true;
  regEditing = info?.id;
  regError = undefined;
  regDraft = {
    name: info?.name ?? '',
    sources: csv(info?.expectedSources ?? null),
    mediums: csv(info?.expectedMediums ?? null),
    startsAt: info?.startsAt ?? '',
    endsAt: info?.endsAt ?? '',
    notes: info?.notes ?? '',
  };
}

async function saveCampaign(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (regSiteId === undefined) return;
  regBusy = true;
  regError = undefined;
  try {
    const body = {
      name: regDraft.name.trim(),
      expectedSources: listOf(regDraft.sources),
      expectedMediums: listOf(regDraft.mediums),
      startsAt: regDraft.startsAt === '' ? null : regDraft.startsAt,
      endsAt: regDraft.endsAt === '' ? null : regDraft.endsAt,
      notes: regDraft.notes.trim() === '' ? null : regDraft.notes.trim(),
    };
    if (regEditing === undefined) await api.createCampaign(regSiteId, body);
    else await api.updateCampaign(regEditing, body);
    regOpen = false;
    campaigns = await api.listCampaigns(regSiteId);
  } catch (failure) {
    regError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    regBusy = false;
  }
}

async function deleteCampaign(id: number): Promise<void> {
  if (regSiteId === undefined) return;
  regRowError = undefined;
  try {
    await api.deleteCampaign(id);
    campaigns = await api.listCampaigns(regSiteId);
  } catch (failure) {
    regRowError = panelFailure(failure, 'Deleting failed — try again.');
  }
}

// ---------- aliases ----------
/** '' in the select means the install-wide list (site 0). */
let aliasSite = $state('0');
const aliasSiteId = $derived(Number(aliasSite));
let aliases = $state<CampaignAlias[] | undefined>(undefined);
let aliasFailed = $state(false);
let aliasBusy = $state(false);
let aliasError = $state<PanelFailure | undefined>(undefined);
let aliasSaved = $state(false);

$effect(() => {
  aliases = undefined;
  aliasSaved = false;
  void api
    .listCampaignAliases(aliasSiteId)
    .then((list) => {
      aliases = list;
    })
    .catch(() => {
      aliasFailed = true;
    });
});

function addAlias(): void {
  if (aliases === undefined) return;
  aliases = [...aliases, { field: 'source', alias: '', canonical: '' }];
}

async function saveAliases(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (aliases === undefined) return;
  aliasBusy = true;
  aliasError = undefined;
  aliasSaved = false;
  const rows = aliases.filter((row) => row.alias.trim() !== '' && row.canonical.trim() !== '');
  try {
    aliases = await api.saveCampaignAliases(aliasSiteId, rows);
    aliasSaved = true;
  } catch (failure) {
    aliasError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    aliasBusy = false;
  }
}

// ---------- UTM link builder (client-only) ----------
let utm = $state<UtmDraft>(emptyUtmDraft());
const utmUrl = $derived(buildUtmUrl(utm));
const utmWarnings = $derived(normalizationWarnings(utm));
const utmMissing = $derived(missingUtmFields(utm));
/** "domain, campaign and source" — an Oxford-less list, not `join(' and ')`. */
const utmMissingText = $derived(
  utmMissing.length < 2
    ? (utmMissing[0] ?? '')
    : `${utmMissing.slice(0, -1).join(', ')} and ${utmMissing.at(-1)}`,
);
let utmCopied = $state(false);

async function copyUtm(): Promise<void> {
  if (utmUrl === undefined) return;
  try {
    await navigator.clipboard.writeText(utmUrl);
    utmCopied = true;
    setTimeout(() => {
      utmCopied = false;
    }, 2000);
  } catch {
    // No secure context — the URL is selectable right there.
  }
}
</script>

<div class="card c12">
  <h2>Campaigns</h2>
  <p class="widget-note">
    The registry behind the <code>campaign_status</code> dimension: a registered campaign is one you
    meant to run. Edits reflect in queries instantly — nothing is rewritten.
  </p>
  <label class="field csite">
    Site
    <select
      value={String(regSiteId ?? '')}
      onchange={(e) => (regSite = Number(e.currentTarget.value))}
    >
      {#each sites ?? [] as site (site.id)}
        <option value={String(site.id)}>{site.name}</option>
      {/each}
    </select>
  </label>
  {#if regFailed}
    <p class="widget-note">Campaigns unavailable.</p>
  {:else if campaigns === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each campaigns as info (info.id)}
      <div class="prow">
        <div class="pmeta">
          <span class="pname">{info.name}</span>
          <span class="psub">
            {info.expectedSources === null ? 'any source' : info.expectedSources.join(', ')}
            · {info.expectedMediums === null ? 'any medium' : info.expectedMediums.join(', ')}
            {info.startsAt === null && info.endsAt === null
              ? ''
              : ` · ${info.startsAt ?? '…'} → ${info.endsAt ?? '…'}`}
          </span>
        </div>
        <button class="btn subtle" type="button" onclick={() => openCampaign(info)}>Edit</button>
        <button class="btn subtle" type="button" onclick={() => void deleteCampaign(info.id)}>
          Delete
        </button>
      </div>
    {:else}
      <p class="widget-note">No registered campaigns for this site.</p>
    {/each}
    <PanelError failure={regRowError} />
    {#if regOpen}
      <form class="oform" onsubmit={saveCampaign}>
        <div class="wrap">
          <label class="field">
            Campaign (the canonical utm_campaign value)
            <input bind:value={regDraft.name} maxlength="200" required />
          </label>
          <label class="field">
            Expected sources (comma-separated; blank = any)
            <input bind:value={regDraft.sources} placeholder="newsletter, mastodon" />
          </label>
          <label class="field">
            Expected mediums (blank = any)
            <input bind:value={regDraft.mediums} placeholder="email, social" />
          </label>
        </div>
        <div class="wrap">
          <label class="field">
            Starts
            <input type="date" bind:value={regDraft.startsAt} />
          </label>
          <label class="field">
            Ends
            <input type="date" bind:value={regDraft.endsAt} />
          </label>
          <label class="field notes">
            Notes
            <input bind:value={regDraft.notes} maxlength="2000" />
          </label>
        </div>
        <PanelError failure={regError} />
        <div class="row">
          <button
            class="btn primary"
            type="submit"
            disabled={regBusy || regDraft.name.trim() === ''}
          >
            {regBusy ? 'Saving…' : 'Save campaign'}
          </button>
          <button class="btn" type="button" onclick={() => (regOpen = false)}>Cancel</button>
        </div>
      </form>
    {:else}
      <button class="btn addv" type="button" onclick={() => openCampaign()}>New campaign</button>
    {/if}
  {/if}
</div>

{#if role === 'admin'}
<div class="card c6">
  <h2>Campaign aliases</h2>
  <p class="widget-note">
    Spelling corrections applied at ingest — <code>tw</code> becomes <code>twitter</code> forever.
    Saving replaces the whole list and rewrites history to match.
  </p>
  <label class="field csite">
    Applies to
    <select bind:value={aliasSite}>
      <option value="0">Every site (install-wide)</option>
      {#each sites ?? [] as site (site.id)}
        <option value={String(site.id)}>{site.name}</option>
      {/each}
    </select>
  </label>
  {#if aliasFailed}
    <p class="widget-note">Aliases unavailable.</p>
  {:else if aliases === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    <form class="oform" onsubmit={saveAliases}>
      {#each aliases as row, index (index)}
        <div class="arow">
          <span class="field">
            <select bind:value={row.field} aria-label="Field {index + 1}">
              <option value="source">source</option>
              <option value="medium">medium</option>
              <option value="campaign">campaign</option>
            </select>
          </span>
          <span class="field aval">
            <input bind:value={row.alias} placeholder="tw" aria-label="Alias {index + 1}" />
          </span>
          <span class="arrow">→</span>
          <span class="field aval">
            <input
              bind:value={row.canonical}
              placeholder="twitter"
              aria-label="Canonical {index + 1}"
            />
          </span>
          <button
            class="btn subtle"
            type="button"
            aria-label="Remove alias {index + 1}"
            onclick={() => (aliases = aliases?.filter((_, i) => i !== index))}>×</button
          >
        </div>
      {:else}
        <p class="widget-note">No aliases here yet.</p>
      {/each}
      <button class="btn addv" type="button" onclick={addAlias}>Add alias</button>
      <PanelError failure={aliasError} />
      {#if aliasSaved}
        <p class="form-ok" role="status">Aliases saved — stored history is being rewritten.</p>
      {/if}
      <div class="row">
        <button class="btn primary" type="submit" disabled={aliasBusy}>
          {aliasBusy ? 'Saving…' : 'Save aliases'}
        </button>
      </div>
    </form>
  {/if}
</div>

{/if}

<div class="card c6">
  <h2>UTM link builder</h2>
  <p class="widget-note">
    Composes a tagged landing URL. Nothing is stored — it only knows how this install will
    normalize what you type.
  </p>
  <div class="oform">
    <div class="wrap">
      <label class="field">
        Domain
        <input bind:value={utm.domain} list="utm-domains" placeholder="blog.example.com" />
      </label>
      <label class="field">
        Path
        <input bind:value={utm.path} placeholder="/launch" />
      </label>
    </div>
    <datalist id="utm-domains">
      {#each sites ?? [] as site (site.id)}
        {#each site.domains as domain (domain)}<option value={domain}></option>{/each}
      {/each}
    </datalist>
    <div class="wrap">
      <label class="field">
        Campaign
        <input bind:value={utm.campaign} list="utm-campaigns" placeholder="spring-launch" />
      </label>
      <label class="field">
        Source
        <input bind:value={utm.source} placeholder="newsletter" />
      </label>
      <label class="field">
        Medium (optional)
        <input bind:value={utm.medium} placeholder="email" />
      </label>
    </div>
    <datalist id="utm-campaigns">
      {#each campaigns ?? [] as info (info.id)}<option value={info.name}></option>{/each}
    </datalist>
    {#each utmWarnings as warning (warning.field)}
      <p class="form-error" role="alert">
        The {warning.field} will be stored as '{warning.stored}' — consider typing it that way.
      </p>
    {/each}
    {#if utmUrl !== undefined && campaigns !== undefined && !campaigns.some((c) => c.name === utm.campaign.trim().toLowerCase())}
      <p class="widget-note">
        This campaign is not in the registry above — its traffic will read as
        <code>unregistered</code>. That is a label, not a loss: the tag is recorded either way.
      </p>
    {/if}
    <!-- Always on screen. Empty, it says what it is waiting for; there is no
         state where the builder simply is not there. -->
    <pre class="utm-url" class:waiting={utmUrl === undefined}><code
        >{utmUrl ?? `Add the ${utmMissingText} to build the link.`}</code
      ></pre>
    <div class="row">
      <button class="btn" type="button" disabled={utmUrl === undefined} onclick={() => void copyUtm()}>
        {utmCopied ? 'Copied ✓' : 'Copy link'}
      </button>
    </div>
  </div>
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

  .wrap .notes {
    flex: 2 1 260px;
  }

  .row {
    display: flex;
    gap: 8px;
  }

  .addv {
    align-self: flex-start;
    margin-top: 4px;
  }

  .csite {
    max-width: 240px;
    margin-bottom: 10px;
  }

  .arow {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .aval {
    flex: 1 1 100px;
    min-width: 0;
  }

  .arrow {
    color: var(--muted);
  }

  .utm-url {
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 12px;
    overflow-x: auto;
    font-size: 11.5px;
    margin: 0;
  }

  .utm-url.waiting {
    border-style: dashed;
    color: var(--ink-2);
    font-style: italic;
  }
</style>
