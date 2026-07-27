<script lang="ts">
import type { AdminDiagnostics, SiteInfo } from '@analytics/shared';
import type { AdminClient } from '../lib/admin.ts';
import { botDropTotals, formatBytes, parseDomains, trackingSnippet } from '../lib/settings.ts';
import { exactNumber } from '../widgets/format.ts';

/**
 * The settings view (docs/04 § 5): sites CRUD, the tracking snippet, password
 * change, diagnostics. All strings shown here are admin- or visitor-authored —
 * text interpolation only (registry.ts boundary note).
 */
interface Props {
  admin: AdminClient;
  /** The live site directory; undefined while it loads. */
  sites: SiteInfo[] | undefined;
  /** Sites changed server-side — the directory (header, cards) must reload. */
  onsiteschanged: () => void;
}

let { admin, sites, onsiteschanged }: Props = $props();

// ---------- sites ----------
interface Draft {
  /** undefined = creating a new site. */
  id: number | undefined;
  name: string;
  domains: string;
  timezone: string;
}

let draft = $state<Draft | undefined>(undefined);
let siteBusy = $state(false);
let siteError = $state<string | undefined>(undefined);
const timezones = Intl.supportedValuesOf('timeZone');

function startEdit(site: SiteInfo): void {
  siteError = undefined;
  draft = {
    id: site.id,
    name: site.name,
    domains: site.domains.join(', '),
    timezone: site.timezone,
  };
}

function startAdd(): void {
  siteError = undefined;
  draft = {
    id: undefined,
    name: '',
    domains: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function saveDraft(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (draft === undefined) return;
  siteBusy = true;
  siteError = undefined;
  const body = {
    name: draft.name.trim(),
    domains: parseDomains(draft.domains),
    timezone: draft.timezone,
  };
  try {
    if (draft.id === undefined) await admin.createSite(body);
    else await admin.updateSite(draft.id, body);
    draft = undefined;
    onsiteschanged();
  } catch (failure) {
    siteError = failure instanceof Error ? failure.message : 'Saving failed — try again.';
  } finally {
    siteBusy = false;
  }
}

// ---------- tracking snippet ----------
let snippetChoice = $state<number | undefined>(undefined);
const snippetSiteId = $derived(snippetChoice ?? sites?.[0]?.id);
const snippet = $derived(
  snippetSiteId === undefined ? undefined : trackingSnippet(snippetSiteId, window.location.origin),
);
let copied = $state(false);
let copyFailed = $state(false);

async function copySnippet(): Promise<void> {
  if (snippet === undefined) return;
  try {
    await navigator.clipboard.writeText(snippet);
    copied = true;
  } catch {
    // Clipboard needs a secure context (plain-http deploys reject) — say so
    // instead of failing silently with an unhandled rejection.
    copyFailed = true;
  }
  setTimeout(() => {
    copied = false;
    copyFailed = false;
  }, 2000);
}

// ---------- password ----------
let currentPassword = $state('');
let nextPassword = $state('');
let confirmPassword = $state('');
let passwordBusy = $state(false);
let passwordError = $state<string | undefined>(undefined);
let passwordChanged = $state(false);
const passwordReady = $derived(
  currentPassword !== '' && nextPassword.length >= 8 && confirmPassword === nextPassword,
);

async function changePassword(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!passwordReady) return;
  passwordBusy = true;
  passwordError = undefined;
  passwordChanged = false;
  try {
    await admin.changePassword(currentPassword, nextPassword);
    passwordChanged = true;
    currentPassword = '';
    nextPassword = '';
    confirmPassword = '';
  } catch (failure) {
    passwordError = failure instanceof Error ? failure.message : 'Change failed — try again.';
  } finally {
    passwordBusy = false;
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
const nameOf = (id: number): string => sites?.find((s) => s.id === id)?.name ?? `Site ${id}`;
</script>

<div class="filters">
  <span class="compare-note">Settings — sites, tracking snippet, password, diagnostics</span>
</div>

<div class="grid">
  <div class="card c6">
    <h2>Sites</h2>
    {#if sites === undefined}
      <p class="widget-note">Loading…</p>
    {:else}
      <div class="site-list">
        {#each sites as site (site.id)}
          <div class="site-row">
            <div class="site-meta">
              <span class="site-name">{site.name}</span>
              <span class="site-sub">
                #{site.id} · {site.domains.length > 0 ? site.domains.join(', ') : 'no domains'} ·
                {site.timezone}
              </span>
            </div>
            <button class="btn subtle" type="button" onclick={() => startEdit(site)}>Edit</button>
          </div>
        {/each}
      </div>
      {#if draft !== undefined}
        <form class="site-form" onsubmit={saveDraft}>
          <h3>{draft.id === undefined ? 'New site' : `Edit ${nameOf(draft.id)}`}</h3>
          <label class="field">
            Name
            <input bind:value={draft.name} required maxlength="200" />
          </label>
          <label class="field">
            Domains (comma-separated; the first is canonical)
            <input bind:value={draft.domains} placeholder="blog.example.com, www.example.com" />
          </label>
          <label class="field">
            Timezone
            <input bind:value={draft.timezone} list="timezones" required />
          </label>
          <datalist id="timezones">
            {#each timezones as tz (tz)}<option value={tz}></option>{/each}
          </datalist>
          {#if siteError !== undefined}<p class="form-error" role="alert">{siteError}</p>{/if}
          <div class="row">
            <button class="btn primary" type="submit" disabled={siteBusy || draft.name.trim() === ''}>
              {siteBusy ? 'Saving…' : 'Save'}
            </button>
            <button class="btn" type="button" onclick={() => (draft = undefined)}>Cancel</button>
          </div>
        </form>
      {:else}
        <button class="btn add-site" type="button" onclick={startAdd}>Add site</button>
      {/if}
    {/if}
  </div>

  <div class="card c6">
    <h2>Tracking snippet</h2>
    {#if snippet === undefined || snippetSiteId === undefined}
      <p class="widget-note">Create a site first.</p>
    {:else}
      <label class="field snippet-site">
        Site
        <select
          value={String(snippetSiteId)}
          onchange={(e) => (snippetChoice = Number(e.currentTarget.value))}
        >
          {#each sites ?? [] as site (site.id)}
            <option value={String(site.id)}>{site.name}</option>
          {/each}
        </select>
      </label>
      <pre class="snippet"><code>{snippet}</code></pre>
      <button class="btn" type="button" onclick={copySnippet}>
        {copied ? 'Copied ✓' : copyFailed ? 'Copy failed — select it manually' : 'Copy snippet'}
      </button>
      <p class="widget-note">
        Paste before <code>&lt;/head&gt;</code>. Existing Matomo tags keep working — same beacon,
        same bundle names.
      </p>
    {/if}
  </div>

  <div class="card c6">
    <h2>Change password</h2>
    <form class="pw-form" onsubmit={changePassword}>
      <label class="field">
        Current password
        <input type="password" bind:value={currentPassword} autocomplete="current-password" />
      </label>
      <label class="field">
        New password (at least 8 characters)
        <input type="password" bind:value={nextPassword} autocomplete="new-password" />
      </label>
      <label class="field">
        Repeat new password
        <input type="password" bind:value={confirmPassword} autocomplete="new-password" />
      </label>
      {#if passwordError !== undefined}<p class="form-error" role="alert">{passwordError}</p>{/if}
      {#if passwordChanged}<p class="form-ok">Password changed. Other sessions were logged out.</p>{/if}
      <button class="btn primary" type="submit" disabled={passwordBusy || !passwordReady}>
        {passwordBusy ? 'Changing…' : 'Change password'}
      </button>
    </form>
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
</div>

<style>
  .site-list {
    display: flex;
    flex-direction: column;
  }

  .site-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--grid);
  }

  .site-meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .site-name {
    font-weight: 600;
  }

  .site-sub {
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .site-form,
  .pw-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .site-form h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-2);
  }

  .row {
    display: flex;
    gap: 8px;
  }

  .add-site {
    margin-top: 12px;
  }

  .snippet-site {
    max-width: 240px;
    margin-bottom: 10px;
  }

  .snippet {
    background: var(--page);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 12px;
    overflow-x: auto;
    font-size: 11.5px;
    line-height: 1.5;
    margin: 0 0 10px;
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
