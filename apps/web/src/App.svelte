<script lang="ts">
import { createAdminClient } from './lib/admin.ts';
import { createAuthState } from './lib/auth.svelte.ts';
import LoginView from './views/LoginView.svelte';
import SetupView from './views/SetupView.svelte';
import Shell from './views/Shell.svelte';

/**
 * The auth switchboard (docs/02 § Security posture): one `/api/admin/me` probe
 * decides between first-run setup, login and the dashboard shell. The shell —
 * with its SSE stream and query client — only exists while a session does.
 */
const admin = createAdminClient({ onUnauthorized: () => auth.unauthorized() });
const auth = createAuthState(admin);
</script>

{#if auth.phase === 'ready'}
  <Shell {admin} {auth} />
{:else if auth.phase === 'setup'}
  <SetupView {auth} />
{:else if auth.phase === 'login'}
  <LoginView {auth} />
{/if}
