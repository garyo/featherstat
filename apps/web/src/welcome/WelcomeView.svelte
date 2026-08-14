<script lang="ts">
/**
 * The invite-claim page (docs/04 § 5): a user chooses their password here.
 * Success signs them in (the claim response sets the session cookies), so the
 * page simply navigates to the app root. Every failure mode of the link —
 * used, expired, disabled, unknown — answers one identical 410.
 */
interface Props {
  token: string;
}

let { token }: Props = $props();
let password = $state('');
let confirm = $state('');
let busy = $state(false);
let error = $state<string | undefined>(undefined);

const mismatch = $derived(confirm !== '' && password !== confirm);

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (password !== confirm) return;
  busy = true;
  error = undefined;
  try {
    let response: Response;
    try {
      response = await fetch(`/claim/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      error = 'Cannot reach the server — is it running?';
      return;
    }
    if (response.status === 410) {
      error = 'This invite link is invalid, already used, or expired — ask for a new one.';
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
      error = body?.error ?? `Something went wrong (${response.status}) — try again.`;
      return;
    }
    // Signed in: a full navigation boots the app with the fresh session.
    window.location.replace('/');
  } finally {
    busy = false;
  }
}
</script>

<div class="auth-wrap">
  <form class="card auth-card" onsubmit={submit}>
    <div class="wordmark">featherstat<span class="dot">.</span></div>
    <p class="auth-what">
      You've been invited to manage sites on this featherstat instance —
      self-hosted, open-source web analytics. Choose a password to claim your
      account; you'll log in with your email from then on.
    </p>
    <h1>Choose a password</h1>
    <label class="field">
      Password
      <input
        type="password"
        bind:value={password}
        autocomplete="new-password"
        minlength={8}
        required
      />
    </label>
    <label class="field">
      Confirm password
      <input type="password" bind:value={confirm} autocomplete="new-password" required />
    </label>
    {#if mismatch}<p class="form-error" role="alert">Passwords don't match.</p>{/if}
    {#if error !== undefined}<p class="form-error" role="alert">{error}</p>{/if}
    <button
      class="btn primary"
      type="submit"
      disabled={busy || password.length < 8 || password !== confirm}
    >
      {busy ? 'Claiming…' : 'Claim account'}
    </button>
  </form>
</div>
