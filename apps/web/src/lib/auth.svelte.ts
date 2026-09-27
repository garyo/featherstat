import { type AdminClient, AdminError } from './admin.ts';

/**
 * The auth phase machine the app root renders by (docs/02 § Security posture):
 * `loading` (one `/api/admin/me` probe) → `setup` (first run, no password yet)
 * | `login` | `ready`. A 401 anywhere later flips `ready` back to `login`.
 */
type AuthPhase = 'loading' | 'setup' | 'login' | 'ready';

/** Which kind of session this is — how the UI decides what to offer. */
export type AuthRole = 'admin' | 'user' | 'viewer';

export interface AuthState {
  readonly phase: AuthPhase;
  /** Last failed action's message, cleared by the next attempt. */
  readonly error: string | undefined;
  readonly busy: boolean;
  /** Defaults to 'admin' until `me` says otherwise — the server refuses anyway. */
  readonly role: AuthRole;
  /** The signed-in user's email; undefined for the admin and viewers. */
  readonly email: string | undefined;
  login(password: string, email?: string): Promise<void>;
  setup(password: string, setupToken: string): Promise<void>;
  logout(): Promise<void>;
  /** Session died mid-use (reported by any API client's 401). */
  unauthorized(): void;
}

export function createAuthState(admin: AdminClient): AuthState {
  let phase = $state<AuthPhase>('loading');
  let error = $state<string | undefined>(undefined);
  let busy = $state(false);
  let role = $state<AuthRole>('admin');
  let email = $state<string | undefined>(undefined);

  const probe = async (): Promise<void> => {
    const me = await admin.me();
    role = me.principal ?? 'admin';
    email = me.email;
    phase = me.authenticated ? 'ready' : me.needsSetup ? 'setup' : 'login';
  };

  void probe().catch(() => {
    phase = 'login';
    error = 'Cannot reach the server — is it running?';
  });

  const attempt = async (action: () => Promise<void>): Promise<void> => {
    busy = true;
    error = undefined;
    try {
      await action();
      // Re-probe rather than assume: `me` names the principal the session got.
      await probe();
    } catch (failure) {
      error = failure instanceof AdminError ? failure.message : 'Something went wrong — try again.';
    } finally {
      busy = false;
    }
  };

  return {
    get phase() {
      return phase;
    },
    get error() {
      return error;
    },
    get busy() {
      return busy;
    },
    get role() {
      return role;
    },
    get email() {
      return email;
    },
    login: (password, loginEmail) => attempt(() => admin.login(password, loginEmail)),
    setup: (password, setupToken) => attempt(() => admin.setup(password, setupToken)),
    async logout() {
      try {
        await admin.logout();
      } catch {
        // the session is gone either way
      }
      error = undefined;
      role = 'admin';
      email = undefined;
      phase = 'login';
    },
    unauthorized() {
      if (phase !== 'ready') return;
      phase = 'login';
      error = 'Session expired — log in again.';
    },
  };
}
