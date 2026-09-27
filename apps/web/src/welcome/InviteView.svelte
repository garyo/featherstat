<script lang="ts">
/**
 * A viewer's magic-link page (docs/04 § 5). Opening the link spends nothing —
 * a chat app unfurling it must not burn a single-use link — so the claim is
 * this button's POST, which signs the viewer in and lands them on the app.
 * Every failure mode of the link answers one identical 410.
 */
interface Props {
  token: string;
}

let { token }: Props = $props();
let busy = $state(false);
let error = $state<string | undefined>(undefined);

async function open(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  busy = true;
  error = undefined;
  try {
    let response: Response;
    try {
      response = await fetch(`/invite/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
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
    window.location.replace('/');
  } finally {
    busy = false;
  }
}
</script>

<div class="auth-wrap">
  <form class="card auth-card" onsubmit={open}>
    <div class="wordmark">featherstat<span class="dot">.</span></div>
    <p class="auth-what">
      You've been invited to view analytics on this featherstat instance —
      self-hosted, open-source web analytics. This link works once, and keeps
      this browser signed in.
    </p>
    {#if error !== undefined}<p class="form-error" role="alert">{error}</p>{/if}
    <button class="btn primary" type="submit" disabled={busy}>
      {busy ? 'Opening…' : 'Open the dashboards'}
    </button>
  </form>
</div>
