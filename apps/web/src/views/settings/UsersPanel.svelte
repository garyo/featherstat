<script lang="ts">
import type { SiteInfo, UserInfo } from '@featherstat/shared';
import { toggleSite } from '../../lib/access.ts';
import type { AdminClient } from '../../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../../lib/admin-failure.ts';
import { adminObjects } from '../../lib/admin-objects.ts';
import PanelError from './PanelError.svelte';

/**
 * The Users panel (docs/04 § 5): password-holding accounts that each own and
 * manage a set of sites — admin-only, like every account surface. The invite
 * link (the claim URL) appears exactly once, in the mint response; a fresh
 * invite for an existing user doubles as a password reset.
 */
interface Props {
  admin: AdminClient;
  sites: SiteInfo[] | undefined;
}

let { admin, sites }: Props = $props();
// svelte-ignore state_referenced_locally
const api = adminObjects(admin);
const nameOf = (id: number): string => sites?.find((s) => s.id === id)?.name ?? `Site ${id}`;
const day = (ms: number): string => new Date(ms).toLocaleDateString();

let users = $state<UserInfo[] | undefined>(undefined);
let usersFailed = $state(false);
let email = $state('');
let inviteSites = $state<number[]>([]);
let inviteBusy = $state(false);
let inviteError = $state<PanelFailure | undefined>(undefined);
let rowError = $state<PanelFailure | undefined>(undefined);
/** The one appearance of a claim link, with whose it is. */
let invite = $state<{ email: string; url: string } | undefined>(undefined);
/** The user whose site assignment is being edited, with the draft set. */
let assigning = $state<{ id: number; sites: number[] } | undefined>(undefined);

const load = (): Promise<void> =>
  api
    .listUsers()
    .then((list) => {
      users = list;
    })
    .catch(() => {
      usersFailed = true;
    });
$effect(() => {
  void load();
});

const inviteUrl = (path: string): string => new URL(path, window.location.origin).toString();

async function createUser(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const address = email.trim();
  if (address === '') return;
  inviteBusy = true;
  inviteError = undefined;
  try {
    const link = await api.createUser({ email: address, sites: inviteSites });
    invite = { email: address, url: inviteUrl(link.url) };
    email = '';
    inviteSites = [];
    await load();
  } catch (failure) {
    inviteError = panelFailure(failure, 'Inviting failed — try again.');
  } finally {
    inviteBusy = false;
  }
}

async function reinvite(user: UserInfo): Promise<void> {
  rowError = undefined;
  try {
    const link = await api.reinviteUser(user.id);
    invite = { email: user.email, url: inviteUrl(link.url) };
  } catch (failure) {
    rowError = panelFailure(failure, 'Inviting failed — try again.');
  }
}

async function disable(id: number): Promise<void> {
  rowError = undefined;
  try {
    await api.disableUser(id);
    await load();
  } catch (failure) {
    rowError = panelFailure(failure, 'Disabling failed — try again.');
  }
}

async function saveAssignment(): Promise<void> {
  if (assigning === undefined) return;
  rowError = undefined;
  try {
    await api.setUserSites(assigning.id, assigning.sites);
    assigning = undefined;
    await load();
  } catch (failure) {
    rowError = panelFailure(failure, 'Saving failed — try again.');
  }
}

const sitesLabel = (user: UserInfo): string =>
  user.sites.length === 0 ? 'no sites yet' : user.sites.map(nameOf).join(', ');

let copied = $state(false);
async function copySecret(secret: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(secret);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 2000);
  } catch {
    // No secure context — the link is selectable right there.
  }
}
</script>

<div class="card c12">
  <h2>Users</h2>
  <p class="widget-note">
    Accounts that log in with email + password and fully manage their own sites — dashboards,
    goals, tracking, and viewer/token invites scoped within them. Send the single-use claim link
    (valid 7 days) yourself — there is no email server here. Sites a user creates are theirs
    automatically.
  </p>
  {#if usersFailed}
    <p class="widget-note">Users unavailable.</p>
  {:else if users === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each users.filter((u) => u.disabledAt === null) as user (user.id)}
      <div class="prow">
        <div class="pmeta">
          <span class="pname">{user.email}</span>
          <span class="psub">
            {sitesLabel(user)} · added {day(user.createdAt)} ·
            {user.hasPassword ? 'active' : 'invite not yet claimed'}
          </span>
        </div>
        <button
          class="btn subtle"
          type="button"
          onclick={() => (assigning = { id: user.id, sites: [...user.sites] })}
        >
          Sites…
        </button>
        <button class="btn subtle" type="button" onclick={() => void reinvite(user)}>
          New link
        </button>
        <button class="btn subtle" type="button" onclick={() => void disable(user.id)}>
          Disable
        </button>
      </div>
      {#if assigning?.id === user.id}
        <fieldset class="scope">
          <legend>Owns and manages</legend>
          {#each sites ?? [] as site (site.id)}
            <label class="check">
              <input
                type="checkbox"
                checked={assigning.sites.includes(site.id)}
                onchange={() => {
                  if (assigning) assigning.sites = toggleSite(assigning.sites, site.id);
                }}
              />
              {site.name}
            </label>
          {/each}
          <div class="row">
            <button class="btn primary" type="button" onclick={() => void saveAssignment()}>
              Save sites
            </button>
            <button class="btn" type="button" onclick={() => (assigning = undefined)}>
              Cancel
            </button>
          </div>
        </fieldset>
      {/if}
    {:else}
      <p class="widget-note">No users yet — this instance is single-operator.</p>
    {/each}
    <PanelError failure={rowError} />
    {#if invite !== undefined}
      <div class="secret" role="status">
        <code>{invite.url}</code>
        <div class="row">
          <button class="btn" type="button" onclick={() => invite && void copySecret(invite.url)}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <span class="widget-note">
            Send it to {invite.email} yourself. You will not see this again.
          </span>
        </div>
      </div>
    {/if}
    <form class="mint" onsubmit={createUser}>
      <label class="field">
        Email
        <input type="email" bind:value={email} maxlength="254" required />
      </label>
      <fieldset class="scope">
        <legend>Starts with</legend>
        {#each sites ?? [] as site (site.id)}
          <label class="check">
            <input
              type="checkbox"
              checked={inviteSites.includes(site.id)}
              onchange={() => (inviteSites = toggleSite(inviteSites, site.id))}
            />
            {site.name}
          </label>
        {:else}
          <p class="widget-note">No sites yet — the user can create their own.</p>
        {/each}
      </fieldset>
      <PanelError failure={inviteError} />
      <button class="btn primary" type="submit" disabled={inviteBusy || email.trim() === ''}>
        {inviteBusy ? 'Minting…' : 'Invite user'}
      </button>
    </form>
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

  .mint {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .scope {
    border: 1px solid var(--grid);
    border-radius: 7px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .scope legend {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-2);
    padding: 0 4px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .secret {
    margin-top: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 12px;
    background: var(--page);
  }

  .secret code {
    display: block;
    word-break: break-all;
    font-size: 11.5px;
    margin-bottom: 8px;
    user-select: all;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
