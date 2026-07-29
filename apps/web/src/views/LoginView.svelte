<script lang="ts">
import type { AuthState } from '../lib/auth.svelte.ts';

/** The whole app while unauthenticated (docs/02: dashboard reads are gated). */
interface Props {
  auth: AuthState;
}

let { auth }: Props = $props();
let password = $state('');

/** Server errors are terse lowercase API strings — dress the common one for people. */
const shownError = $derived(
  auth.error === 'wrong password' ? 'Wrong password — try again.' : auth.error,
);

function submit(event: SubmitEvent): void {
  event.preventDefault();
  void auth.login(password);
}
</script>

<div class="auth-wrap">
  <form class="card auth-card" onsubmit={submit}>
    <div class="wordmark">featherstat<span class="dot">.</span></div>
    <p class="auth-what">
      Private analytics console for this site's owner. featherstat is
      self-hosted, open-source web analytics; this page asks only for the
      operator's own password and collects nothing from visitors.
    </p>
    <h1>Log in</h1>
    <label class="field">
      Password
      <input
        type="password"
        bind:value={password}
        autocomplete="current-password"
        required
      />
    </label>
    {#if shownError !== undefined}<p class="form-error" role="alert">{shownError}</p>{/if}
    <button class="btn primary" type="submit" disabled={auth.busy || password === ''}>
      {auth.busy ? 'Logging in…' : 'Log in'}
    </button>
  </form>
</div>
