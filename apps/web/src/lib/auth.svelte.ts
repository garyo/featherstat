import { type AdminClient, AdminError } from './admin.ts';

/**
 * The auth phase machine the app root renders by (docs/02 § Security posture):
 * `loading` (one `/api/admin/me` probe) → `setup` (first run, no password yet)
 * | `login` | `ready`. A 401 anywhere later flips `ready` back to `login`.
 */
export type AuthPhase = 'loading' | 'setup' | 'login' | 'ready';

export interface AuthState {
  readonly phase: AuthPhase;
  /** Last failed action's message, cleared by the next attempt. */
  readonly error: string | undefined;
  readonly busy: boolean;
  login(password: string): Promise<void>;
  setup(password: string, setupToken: string): Promise<void>;
  logout(): Promise<void>;
  /** Session died mid-use (reported by any API client's 401). */
  unauthorized(): void;
}

export function createAuthState(admin: AdminClient): AuthState {
  let phase = $state<AuthPhase>('loading');
  let error = $state<string | undefined>(undefined);
  let busy = $state(false);

  void admin
    .me()
    .then((me) => {
      phase = me.authenticated ? 'ready' : me.needsSetup ? 'setup' : 'login';
    })
    .catch(() => {
      phase = 'login';
      error = 'Cannot reach the server — is it running?';
    });

  const attempt = async (action: () => Promise<void>): Promise<void> => {
    busy = true;
    error = undefined;
    try {
      await action();
      phase = 'ready';
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
    login: (password) => attempt(() => admin.login(password)),
    setup: (password, setupToken) => attempt(() => admin.setup(password, setupToken)),
    async logout() {
      try {
        await admin.logout();
      } catch {
        // the session is gone either way
      }
      error = undefined;
      phase = 'login';
    },
    unauthorized() {
      if (phase !== 'ready') return;
      phase = 'login';
      error = 'Session expired — log in again.';
    },
  };
}
