<script lang="ts">
import type { ApiTokenInfo, SiteInfo, ViewerInfo } from '@featherstat/shared';
import { emptyScope, type ScopeDraft, scopeLabel, scopeOf, toggleSite } from '../../lib/access.ts';
import type { AdminClient } from '../../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../../lib/admin-failure.ts';
import { adminObjects } from '../../lib/admin-objects.ts';
import type { AuthRole } from '../../lib/auth.svelte.ts';
import PanelError from './PanelError.svelte';

/**
 * The Access panels (docs/04 § 5): API tokens and invited viewers — the two
 * read-only principals an admin mints. Both secrets (the bearer token, the
 * magic-link URL) appear exactly once, in the mint response; the lists that
 * follow only ever show names, scopes and dates.
 *
 * A row's verb reports beside the row, not down in the mint form: a revoke that
 * failed must not look like one that worked.
 */
interface Props {
  admin: AdminClient;
  sites: SiteInfo[] | undefined;
  /** A user mints only within their own sites — 'all' is the admin's scope. */
  role?: AuthRole;
}

let { admin, sites, role = 'admin' }: Props = $props();
// svelte-ignore state_referenced_locally
const api = adminObjects(admin);
/** Users start on "Only:" because "All sites" is not theirs to grant. */
const initialScope = (): ScopeDraft =>
  role === 'admin' ? emptyScope() : { all: false, sites: [] };
const nameOf = (id: number): string => sites?.find((s) => s.id === id)?.name ?? `Site ${id}`;
const day = (ms: number): string => new Date(ms).toLocaleDateString();

// ---------- API tokens ----------
let tokens = $state<ApiTokenInfo[] | undefined>(undefined);
let tokensFailed = $state(false);
let tokenName = $state('');
let tokenScope = $state<ScopeDraft>(initialScope());
let tokenBusy = $state(false);
let tokenError = $state<PanelFailure | undefined>(undefined);
/** The revoke button's own report — the mint form is elsewhere on the card. */
let tokenRowError = $state<PanelFailure | undefined>(undefined);
/** The one appearance of the raw bearer token — gone on reload, by design. */
let minted = $state<string | undefined>(undefined);

const loadTokens = (): Promise<void> =>
  api
    .listTokens()
    .then((list) => {
      tokens = list;
    })
    .catch(() => {
      tokensFailed = true;
    });
$effect(() => {
  void loadTokens();
});

async function mintToken(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const scope = scopeOf(tokenScope);
  if (scope === undefined || tokenName.trim() === '') return;
  tokenBusy = true;
  tokenError = undefined;
  try {
    const grant = await api.createToken({ name: tokenName.trim(), sites: scope });
    minted = grant.token;
    tokenName = '';
    tokenScope = initialScope();
    await loadTokens();
  } catch (failure) {
    tokenError = panelFailure(failure, 'Minting failed — try again.');
  } finally {
    tokenBusy = false;
  }
}

async function revokeToken(id: number): Promise<void> {
  tokenRowError = undefined;
  try {
    await api.revokeToken(id);
    await loadTokens();
  } catch (failure) {
    tokenRowError = panelFailure(failure, 'Revoking failed — try again.');
  }
}

// ---------- viewers ----------
let viewers = $state<ViewerInfo[] | undefined>(undefined);
let viewersFailed = $state(false);
let viewerEmail = $state('');
let viewerScope = $state<ScopeDraft>(initialScope());
let viewerBusy = $state(false);
let viewerError = $state<PanelFailure | undefined>(undefined);
let viewerRowError = $state<PanelFailure | undefined>(undefined);
/** The one appearance of a magic link, with whose it is. */
let invite = $state<{ email: string; url: string } | undefined>(undefined);

const loadViewers = (): Promise<void> =>
  api
    .listViewers()
    .then((list) => {
      viewers = list;
    })
    .catch(() => {
      viewersFailed = true;
    });
$effect(() => {
  void loadViewers();
});

const inviteUrl = (path: string): string => new URL(path, window.location.origin).toString();

async function inviteViewer(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const scope = scopeOf(viewerScope);
  const email = viewerEmail.trim();
  if (scope === undefined || email === '') return;
  viewerBusy = true;
  viewerError = undefined;
  try {
    const link = await api.inviteViewer({ email, sites: scope });
    invite = { email, url: inviteUrl(link.url) };
    viewerEmail = '';
    viewerScope = initialScope();
    await loadViewers();
  } catch (failure) {
    viewerError = panelFailure(failure, 'Inviting failed — try again.');
  } finally {
    viewerBusy = false;
  }
}

async function reinvite(viewer: ViewerInfo): Promise<void> {
  viewerRowError = undefined;
  try {
    const link = await api.reinviteViewer(viewer.id);
    invite = { email: viewer.email, url: inviteUrl(link.url) };
  } catch (failure) {
    viewerRowError = panelFailure(failure, 'Inviting failed — try again.');
  }
}

async function revokeViewer(id: number): Promise<void> {
  viewerRowError = undefined;
  try {
    await api.revokeViewer(id);
    await loadViewers();
  } catch (failure) {
    viewerRowError = panelFailure(failure, 'Revoking failed — try again.');
  }
}

// ---------- the once-only secret line both cards share ----------
let copied = $state(false);
async function copySecret(secret: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(secret);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 2000);
  } catch {
    // No secure context — the secret is selectable right there.
  }
}
</script>

{#snippet scopePicker(draft: ScopeDraft, kind: string)}
  <fieldset class="scope">
    <legend>Can read</legend>
    {#if role === 'admin'}
      <label class="check">
        <input type="radio" name="{kind}-scope" checked={draft.all} onchange={() => (draft.all = true)} />
        All sites
      </label>
      <label class="check">
        <input
          type="radio"
          name="{kind}-scope"
          checked={!draft.all}
          onchange={() => (draft.all = false)}
        />
        Only:
      </label>
    {/if}
    {#each sites ?? [] as site (site.id)}
      <label class="check indent">
        <input
          type="checkbox"
          disabled={draft.all}
          checked={draft.sites.includes(site.id)}
          onchange={() => (draft.sites = toggleSite(draft.sites, site.id))}
        />
        {site.name}
      </label>
    {/each}
  </fieldset>
{/snippet}

{#snippet secretOnce(secret: string, note: string)}
  <div class="secret" role="status">
    <code>{secret}</code>
    <div class="row">
      <button class="btn" type="button" onclick={() => void copySecret(secret)}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
      <span class="widget-note">{note} You will not see this again.</span>
    </div>
  </div>
{/snippet}

<div class="card c6">
  <h2>API tokens</h2>
  <p class="widget-note">
    Bearer credentials for scripts, CSV pulls and MCP — read-only, scoped, sent as
    <code>Authorization: Bearer …</code>.
  </p>
  {#if tokensFailed}
    <p class="widget-note">Tokens unavailable.</p>
  {:else if tokens === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each tokens.filter((t) => t.revokedAt === null) as token (token.id)}
      <div class="prow">
        <div class="pmeta">
          <span class="pname">{token.name}</span>
          <span class="psub">
            {scopeLabel(token.sites, nameOf)} · minted {day(token.createdAt)} ·
            {token.lastUsedAt === null ? 'never used' : `last used ${day(token.lastUsedAt)}`}
          </span>
        </div>
        <button class="btn subtle" type="button" onclick={() => void revokeToken(token.id)}>
          Revoke
        </button>
      </div>
    {:else}
      <p class="widget-note">No live tokens.</p>
    {/each}
    <PanelError failure={tokenRowError} />
    {#if minted !== undefined}
      {@render secretOnce(minted, 'Store it where the script runs.')}
    {/if}
    <form class="mint" onsubmit={mintToken}>
      <label class="field">
        Name
        <input bind:value={tokenName} maxlength="64" placeholder="nightly-export" required />
      </label>
      {@render scopePicker(tokenScope, 'token')}
      <PanelError failure={tokenError} />
      <button
        class="btn primary"
        type="submit"
        disabled={tokenBusy || tokenName.trim() === '' || scopeOf(tokenScope) === undefined}
      >
        {tokenBusy ? 'Minting…' : 'Mint token'}
      </button>
    </form>
  {/if}
</div>

<div class="card c6">
  <h2>Viewers</h2>
  <p class="widget-note">
    Read-only dashboard access without a password: mint a single-use invite link (valid 7 days) and
    deliver it yourself — there is no email server here.
  </p>
  {#if viewersFailed}
    <p class="widget-note">Viewers unavailable.</p>
  {:else if viewers === undefined}
    <p class="widget-note">Loading…</p>
  {:else}
    {#each viewers.filter((v) => v.revokedAt === null) as viewer (viewer.id)}
      <div class="prow">
        <div class="pmeta">
          <span class="pname">{viewer.email}</span>
          <span class="psub">{scopeLabel(viewer.sites, nameOf)} · invited {day(viewer.createdAt)}</span>
        </div>
        <button class="btn subtle" type="button" onclick={() => void reinvite(viewer)}>
          New link
        </button>
        <button class="btn subtle" type="button" onclick={() => void revokeViewer(viewer.id)}>
          Revoke
        </button>
      </div>
    {:else}
      <p class="widget-note">No viewers yet.</p>
    {/each}
    <PanelError failure={viewerRowError} />
    {#if invite !== undefined}
      {@render secretOnce(invite.url, `Send it to ${invite.email} yourself.`)}
    {/if}
    <form class="mint" onsubmit={inviteViewer}>
      <label class="field">
        Email
        <input type="email" bind:value={viewerEmail} maxlength="254" required />
      </label>
      {@render scopePicker(viewerScope, 'viewer')}
      <PanelError failure={viewerError} />
      <button
        class="btn primary"
        type="submit"
        disabled={viewerBusy || viewerEmail.trim() === '' || scopeOf(viewerScope) === undefined}
      >
        {viewerBusy ? 'Minting…' : 'Invite viewer'}
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

  .check.indent {
    margin-left: 18px;
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
