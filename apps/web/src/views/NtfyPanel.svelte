<script lang="ts">
import { MAX_NTFY_RULES, type SiteInfo } from '@featherstat/shared';
import { type AdminClient, AdminError } from '../lib/admin.ts';
import { type PanelFailure, panelFailure } from '../lib/admin-failure.ts';
import ConfirmButton from '../lib/components/ConfirmButton.svelte';
import { createLoader } from '../lib/loader.svelte.ts';
import {
  draftFrom,
  emptyRule,
  fieldErrors,
  type NtfyDraft,
  type NtfyErrors,
  settingsBody,
} from '../lib/ntfy.ts';
import LoadState from './settings/LoadState.svelte';
import PanelError from './settings/PanelError.svelte';

/**
 * Notification settings (docs/01 R16, `/api/admin/ntfy`): where hits go when
 * they match a rule. The server validates whatever arrives — this form's job is
 * to send the shape it asked for and to put each refusal under the field that
 * caused it.
 *
 * The bearer token is write-only by design: a read reports only that one is
 * stored, so an empty box means "unchanged" and forgetting one is explicit.
 */
interface Props {
  admin: AdminClient;
  /** The site directory, so a rule picks a site by name rather than by id. */
  sites: SiteInfo[] | undefined;
}

let { admin, sites }: Props = $props();

let draft = $state<NtfyDraft | undefined>(undefined);
let tokenSet = $state(false);
/** The SERVER currently has an endpoint stored — what "disable" acts on. */
let storedConfigured = $state(false);
const stored = createLoader(() => admin.ntfySettings(), {
  onload: (view) => {
    draft = draftFrom(view);
    tokenSet = view.tokenSet;
    storedConfigured = view.url !== undefined && view.topic !== undefined;
  },
});
void stored.load();
let busy = $state(false);
let saved = $state<string | undefined>(undefined);
let errors = $state<NtfyErrors>({ rules: new Map() });
let test = $state<({ ok: boolean } & PanelFailure) | undefined>(undefined);

const configured = $derived(draft !== undefined && draft.url !== '' && draft.topic !== '');

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (draft === undefined) return;
  busy = true;
  saved = undefined;
  test = undefined;
  errors = { rules: new Map() };
  const { body, rows } = settingsBody(draft);
  const dropped = draft.rules.length - rows.length;
  try {
    stored.set(await admin.saveNtfySettings(body));
    saved =
      dropped > 0
        ? `Notification settings saved. ${dropped} empty rule row${dropped === 1 ? '' : 's'} removed.`
        : 'Notification settings saved.';
  } catch (failure) {
    const said = panelFailure(failure, 'Saving failed — try again.');
    errors =
      failure instanceof AdminError && !said.urgent
        ? fieldErrors(failure.issues, rows, said.message)
        : { rules: new Map(), form: said };
  } finally {
    busy = false;
  }
}

/** Delivered with the SAVED settings, so what it proves is what the notifier will do. */
async function sendTest(): Promise<void> {
  busy = true;
  saved = undefined;
  test = undefined;
  try {
    await admin.testNtfy();
    test = { ok: true, message: 'Test notification sent.', urgent: false };
  } catch (failure) {
    test = { ok: false, ...panelFailure(failure, 'Sending failed — try again.') };
  } finally {
    busy = false;
  }
}

/** Turning it off is a server-side forget, not just an emptied form. */
async function disable(): Promise<void> {
  busy = true;
  saved = undefined;
  test = undefined;
  errors = { rules: new Map() };
  try {
    stored.set(await admin.clearNtfySettings());
    saved = 'Notifications disabled — endpoint, token and rules forgotten.';
  } catch (failure) {
    errors = { rules: new Map(), form: panelFailure(failure, 'Disabling failed — try again.') };
  } finally {
    busy = false;
  }
}

function addRule(): void {
  if (draft === undefined || draft.rules.length >= MAX_NTFY_RULES) return;
  draft.rules = [...draft.rules, emptyRule()];
}

function removeRule(index: number): void {
  if (draft === undefined) return;
  draft.rules = draft.rules.filter((_, i) => i !== index);
}
</script>

<div class="card c12">
  <h2>Notifications</h2>
  <LoadState of={stored} what="Notification settings">
    {#snippet children()}
      {#if draft !== undefined}
        <form class="ntfy-form" onsubmit={save}>
          <div class="endpoint">
            <label class="field">
              ntfy server
              <input
                bind:value={draft.url}
                placeholder="https://ntfy.example.com"
                aria-invalid={errors.url !== undefined}
              />
            </label>
            <label class="field">
              Topic
              <input
                bind:value={draft.topic}
                placeholder="analytics"
                aria-invalid={errors.topic !== undefined}
              />
            </label>
            <label class="field">
              Access token {tokenSet ? '(stored)' : '(optional)'}
              <input
                type="password"
                bind:value={draft.token}
                autocomplete="off"
                placeholder={tokenSet ? 'leave blank to keep' : 'for protected topics'}
              />
            </label>
          </div>
          {#if errors.url !== undefined}<p class="form-error" role="alert">Server: {errors.url}</p>{/if}
          {#if errors.topic !== undefined}
            <p class="form-error" role="alert">Topic: {errors.topic}</p>
          {/if}
          {#if tokenSet}
            <label class="check">
              <input type="checkbox" bind:checked={draft.clearToken} />
              Forget the stored token
            </label>
          {/if}

          <h3>Rules</h3>
          <p class="widget-note">
            A hit notifies when every field you fill matches it; blank fields don't constrain.
            Whichever rule matches first owns the hit, and each rule sends at most once a minute.
          </p>
          {#each draft.rules as rule, index (index)}
            <div class="rule">
              <label class="field">
                Site
                <select bind:value={rule.site}>
                  <option value="">Any site</option>
                  {#each sites ?? [] as site (site.id)}
                    <option value={String(site.id)}>{site.name}</option>
                  {/each}
                </select>
              </label>
              <label class="field">
                Category
                <input bind:value={rule.eventCategory} placeholder="signup" />
              </label>
              <label class="field">
                Action
                <input bind:value={rule.eventAction} placeholder="account-created" />
              </label>
              <label class="field">
                Label
                <input bind:value={rule.label} placeholder="any" />
              </label>
              <button
                class="btn subtle drop"
                type="button"
                aria-label="Remove rule {index + 1}"
                onclick={() => removeRule(index)}>×</button
              >
            </div>
            {#if errors.rules.get(index) !== undefined}
              <p class="form-error" role="alert">Rule {index + 1}: {errors.rules.get(index)}</p>
            {/if}
          {:else}
            <p class="widget-note">No rules yet — nothing is sent.</p>
          {/each}
          <button
            class="btn add-rule"
            type="button"
            disabled={draft.rules.length >= MAX_NTFY_RULES}
            onclick={addRule}>Add rule</button
          >

          <PanelError failure={errors.form} />
          {#if saved !== undefined}<p class="form-ok" role="status">{saved}</p>{/if}
          {#if test?.ok}
            <p class="form-ok" role="status">{test.message}</p>
          {:else}
            <PanelError failure={test} />
          {/if}
          <div class="row">
            <button
              class="btn primary"
              type="submit"
              disabled={busy || !configured}
              title={configured ? undefined : 'Fill in the ntfy server and topic first'}
            >
              {busy ? 'Saving…' : 'Save notification settings'}
            </button>
            <!-- Sends with what is STORED, so save first; the button says as much. -->
            <button
              class="btn"
              type="button"
              disabled={busy || !storedConfigured}
              title={storedConfigured ? undefined : 'Save an ntfy server and topic first'}
              onclick={() => void sendTest()}
            >
              Send test notification
            </button>
            {#if storedConfigured}
              <ConfirmButton
                class="btn"
                label="Disable notifications"
                confirm="Really forget the endpoint, token and every rule?"
                pending="Disabling…"
                disabled={busy}
                onconfirm={disable}
              />
            {/if}
          </div>
        </form>
      {/if}
    {/snippet}
  </LoadState>
</div>

<style>
  .ntfy-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .endpoint {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .endpoint .field {
    flex: 1 1 200px;
    min-width: 0;
  }

  h3 {
    margin: 6px 0 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-2);
  }

  .rule {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px;
  }

  .rule .field {
    flex: 1 1 150px;
    min-width: 0;
  }

  .drop {
    flex: 0 0 auto;
    padding: 6px 10px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--ink-2);
  }

  .add-rule {
    align-self: flex-start;
  }

  .row {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
</style>
