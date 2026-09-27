<script lang="ts">
import type { SiteInfo } from '@featherstat/shared';
import type { AdminClient } from '../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../lib/admin-failure.ts';
import type { AuthRole } from '../lib/auth.svelte.ts';
import { parseDomains, trackingSnippet } from '../lib/settings.ts';
import type { SettingsSection } from '../lib/state.ts';
import { confirmDiscard, edited } from '../lib/unsaved.ts';
import AccessPanels from './settings/AccessPanels.svelte';
import CampaignPanels from './settings/CampaignPanels.svelte';
import DataPanels from './settings/DataPanels.svelte';
import NotifyPanels from './settings/NotifyPanels.svelte';
import PanelError from './settings/PanelError.svelte';
import QueryPanels from './settings/QueryPanels.svelte';
import UsersPanel from './settings/UsersPanel.svelte';

/**
 * The settings view (docs/04 § 5, docs/05 § Settings): a section nav over every
 * admin surface — Sites & tracking (sites CRUD, the snippet, the password),
 * Access (tokens + viewers), Query objects (segments + derived metrics +
 * goals), Campaigns (registry + aliases + link builder), Notifications (ntfy +
 * alert rules), Data (props + annotations + diagnostics). All strings shown
 * here are admin- or visitor-authored — text interpolation only (registry.ts
 * boundary note).
 *
 * Loaded as ONE chunk (Shell.svelte): none of this belongs on the path to a
 * dashboard, which is what every session opens on. The section panels are
 * static imports, deliberately NOT nested `import()` sub-chunks: a dynamic
 * import inside a non-entry chunk splits vite's preload helper (and every
 * module this chunk shares with the entry graph) into preloaded siblings, and
 * that costs first-load bytes the docs/05 budget does not have. One admin-only
 * chunk, loaded on entering Settings, is the shape that leaves the entry graph
 * untouched — build.guard.ts holds it to its own ceiling.
 */
interface Props {
  admin: AdminClient;
  /** The live site directory; undefined while it loads. */
  sites: SiteInfo[] | undefined;
  /** Which sections this session may hold — a user gets the per-site ones. */
  role?: AuthRole;
  /** Sites changed server-side — the directory (header, cards) must reload. */
  onsiteschanged: () => void;
  /** The section the URL names (`?section=`); undefined opens the first. */
  section?: SettingsSection;
  /** Puts a chosen section in the URL. Without it, the choice stays local to this view. */
  onselectsection?: (section: SettingsSection) => void;
}

let {
  admin,
  sites,
  role = 'admin',
  onsiteschanged,
  section: requested,
  onselectsection,
}: Props = $props();

// ---------- sections ----------
type Section = SettingsSection;
const ALL_SECTIONS: ReadonlyArray<{ id: Section; label: string; adminOnly?: boolean }> = [
  { id: 'sites', label: 'Sites & tracking' },
  { id: 'access', label: 'Access' },
  { id: 'users', label: 'Users', adminOnly: true },
  { id: 'query', label: 'Query objects' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'notify', label: 'Notifications', adminOnly: true },
  { id: 'data', label: 'Data', adminOnly: true },
];
const SECTIONS = $derived(ALL_SECTIONS.filter((s) => role === 'admin' || s.adminOnly !== true));
let chosen = $state<Section | undefined>(undefined);
/** A section this role does not hold (a hand-edited URL) opens the first one. */
const section = $derived.by(() => {
  const want = requested ?? chosen;
  return SECTIONS.find((entry) => entry.id === want)?.id ?? 'sites';
});

/** Panel props are uniform, so one component slot serves every section. */
const PANELS: Record<Exclude<Section, 'sites'>, typeof AccessPanels> = {
  access: AccessPanels,
  users: UsersPanel,
  query: QueryPanels,
  campaigns: CampaignPanels,
  notify: NotifyPanels,
  data: DataPanels,
};
const Panel = $derived(section === 'sites' ? undefined : PANELS[section]);
let panel = $state<ReturnType<typeof AccessPanels> | undefined>(undefined);

/** Whether leaving the section on screen would throw away an edit. */
export function unsaved(): boolean {
  if (section !== 'sites') return panel?.unsaved() ?? false;
  return (
    (draft !== undefined && edited(draft, draftOpened)) ||
    currentPassword !== '' ||
    nextPassword !== '' ||
    confirmPassword !== ''
  );
}

function selectSection(next: Section): void {
  if (next === section) return;
  const label = ALL_SECTIONS.find((entry) => entry.id === section)?.label ?? 'this section';
  if (!confirmDiscard(unsaved(), label, (message) => window.confirm(message))) return;
  if (onselectsection === undefined) chosen = next;
  else onselectsection(next);
}

// ---------- sites ----------
interface Draft {
  /** undefined = creating a new site. */
  id: number | undefined;
  name: string;
  domains: string;
  timezone: string;
}

let draft = $state<Draft | undefined>(undefined);
let draftOpened: Draft | undefined;
let siteBusy = $state(false);
let siteError = $state<PanelFailure | undefined>(undefined);
/** The typed-confirmation gate: the name must be re-typed exactly to delete. */
let deleting = $state(false);
let deleteConfirm = $state('');
const timezones = Intl.supportedValuesOf('timeZone');

function startEdit(site: SiteInfo): void {
  siteError = undefined;
  deleting = false;
  deleteConfirm = '';
  draft = {
    id: site.id,
    name: site.name,
    domains: site.domains.join(', '),
    timezone: site.timezone,
  };
  draftOpened = $state.snapshot(draft);
}

function startAdd(): void {
  siteError = undefined;
  draft = {
    id: undefined,
    name: '',
    domains: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  draftOpened = $state.snapshot(draft);
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
    siteError = panelFailure(failure, 'Saving failed — try again.');
  } finally {
    siteBusy = false;
  }
}

async function deleteSite(): Promise<void> {
  if (draft?.id === undefined || deleteConfirm !== nameOf(draft.id)) return;
  siteBusy = true;
  siteError = undefined;
  try {
    await admin.deleteSite(draft.id);
    draft = undefined;
    deleting = false;
    onsiteschanged();
  } catch (failure) {
    siteError = panelFailure(failure, 'Deleting failed — try again.');
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
    // NOT panelFailure(): this route answers a wrong CURRENT password with 403,
    // which is the typed password's fault, not the session's.
    passwordError = failure instanceof Error ? failure.message : 'Change failed — try again.';
  } finally {
    passwordBusy = false;
  }
}

const nameOf = (id: number): string => sites?.find((s) => s.id === id)?.name ?? `Site ${id}`;
</script>

<div class="filters">
  <nav class="settings-nav" aria-label="Settings sections">
    {#each SECTIONS as entry (entry.id)}
      <button
        class="btn slim"
        class:primary={section === entry.id}
        type="button"
        aria-current={section === entry.id ? 'page' : undefined}
        onclick={() => selectSection(entry.id)}
      >
        {entry.label}
      </button>
    {/each}
  </nav>
</div>

<div class="grid">
  {#if section === 'sites'}
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
            {#if draft.id !== undefined && draft.timezone !== sites.find((s) => s.id === draft?.id)?.timezone}
              <p class="widget-note">
                Saving re-dates this site's stored history into the new timezone, in the
                background. Days retention has already pruned keep the old one.
              </p>
            {/if}
            <PanelError failure={siteError} />
            <div class="row">
              <button
                class="btn primary"
                type="submit"
                disabled={siteBusy || draft.name.trim() === ''}
              >
                {siteBusy ? 'Saving…' : 'Save'}
              </button>
              <button class="btn" type="button" onclick={() => (draft = undefined)}>Cancel</button>
              {#if draft.id !== undefined && !deleting}
                <button class="btn danger spaced" type="button" onclick={() => (deleting = true)}>
                  Delete site…
                </button>
              {/if}
            </div>
            {#if draft.id !== undefined && deleting}
              <div class="delete-confirm">
                <p class="widget-note">
                  This deletes <strong>{nameOf(draft.id)}</strong> and all its data — every stored
                  event, session, goal, campaign and dashboard scoped to it. There is no undo. Type
                  the site's name to confirm.
                </p>
                <label class="field">
                  Site name
                  <input bind:value={deleteConfirm} placeholder={nameOf(draft.id)} />
                </label>
                <div class="row">
                  <button
                    class="btn danger"
                    type="button"
                    disabled={siteBusy || deleteConfirm !== nameOf(draft.id)}
                    onclick={() => void deleteSite()}
                  >
                    Delete this site and all its data
                  </button>
                  <button class="btn" type="button" onclick={() => (deleting = false)}>Keep</button>
                </div>
              </div>
            {/if}
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
          Paste before <code>&lt;/head&gt;</code>. Safe to add while another analytics tag is still
          running — it shares no globals, so you can compare the two before switching. Already on
          Matomo? Existing tags keep working against this server unchanged.
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
        {#if passwordChanged}
          <p class="form-ok">Password changed. Other sessions were logged out.</p>
        {/if}
        <button class="btn primary" type="submit" disabled={passwordBusy || !passwordReady}>
          {passwordBusy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  {:else if Panel !== undefined}
    <Panel bind:this={panel} {admin} {sites} {role} />
  {/if}
</div>

<style>
  .settings-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

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

  .danger {
    color: var(--bad);
  }

  .spaced {
    margin-left: auto;
  }

  .delete-confirm {
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-top: 1px solid var(--grid);
    padding-top: 10px;
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
</style>
