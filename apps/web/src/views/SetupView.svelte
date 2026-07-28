<script lang="ts">
import type { AuthState } from '../lib/auth.svelte.ts';

/** First run (docs/04 § 5): no password exists yet — choose one, nothing else works. */
interface Props {
  auth: AuthState;
}

const MIN_LENGTH = 8;

let { auth }: Props = $props();
let password = $state('');
let confirm = $state('');
let setupToken = $state('');

const tooShort = $derived(password !== '' && password.length < MIN_LENGTH);
const mismatch = $derived(confirm !== '' && confirm !== password);
const ready = $derived(
  password.length >= MIN_LENGTH && confirm === password && setupToken.trim() !== '',
);

function submit(event: SubmitEvent): void {
  event.preventDefault();
  if (ready) void auth.setup(password, setupToken.trim());
}
</script>

<div class="auth-wrap">
  <form class="card auth-card" onsubmit={submit}>
    <div class="wordmark">featherstat<span class="dot">.</span></div>
    <h1>Welcome — set the admin password</h1>
    <p class="hint">
      One admin account guards the dashboards. Tracking endpoints stay public either way.
    </p>
    <label class="field">
      Password (at least {MIN_LENGTH} characters)
      <input type="password" bind:value={password} autocomplete="new-password" required />
    </label>
    <label class="field">
      Repeat password
      <input type="password" bind:value={confirm} autocomplete="new-password" required />
    </label>
    <label class="field">
      Setup token (printed in the server log at first boot)
      <input type="text" bind:value={setupToken} autocomplete="off" spellcheck="false" required />
    </label>
    {#if tooShort}
      <p class="form-error">Needs at least {MIN_LENGTH} characters.</p>
    {:else if mismatch}
      <p class="form-error">Passwords don't match.</p>
    {/if}
    {#if auth.error !== undefined}<p class="form-error" role="alert">{auth.error}</p>{/if}
    <button class="btn primary" type="submit" disabled={auth.busy || !ready}>
      {auth.busy ? 'Saving…' : 'Set password & start'}
    </button>
  </form>
</div>
