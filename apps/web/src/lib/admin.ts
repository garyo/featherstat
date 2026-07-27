import type {
  AdminDiagnostics,
  AdminMe,
  AdminSessionGrant,
  AdminSiteCreate,
  AdminSitePatch,
  SiteInfo,
} from '@analytics/shared';

/**
 * The admin API client (docs/04 § 5). The session rides in HttpOnly cookies;
 * this module's only credential work is the CSRF echo: it remembers the token
 * from `me`/`login`/`setup` (falling back to the readable `csrf` cookie) and
 * sends it as `x-csrf-token` on every mutation — the double-submit pair.
 *
 * A 401 from any authenticated call reports to `onUnauthorized` (the app flips
 * to the login view) and still throws, so callers never see a half-result.
 */

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface AdminClientOptions {
  fetch?: typeof fetch;
  /** A session died mid-use (401 outside login) — show the login view. */
  onUnauthorized?: () => void;
}

export interface AdminClient {
  me(): Promise<AdminMe>;
  setup(password: string, setupToken: string): Promise<void>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  createSite(site: AdminSiteCreate): Promise<SiteInfo>;
  updateSite(id: number, patch: AdminSitePatch): Promise<SiteInfo>;
  diagnostics(): Promise<AdminDiagnostics>;
}

export function createAdminClient(options: AdminClientOptions = {}): AdminClient {
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let csrf: string | undefined;

  async function call<T>(
    path: string,
    init: { method?: string; body?: unknown; authenticated?: boolean } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') {
      const token = csrf ?? csrfCookie();
      if (token !== undefined) headers['x-csrf-token'] = token;
    }
    const response = await fetchImpl(path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.status === 401 && (init.authenticated ?? true)) options.onUnauthorized?.();
    if (!response.ok) throw new AdminError(response.status, await errorMessage(response));
    return (await response.json()) as T;
  }

  return {
    async me() {
      const me = await call<AdminMe>('/api/admin/me', { authenticated: false });
      csrf = me.csrf ?? csrf;
      return me;
    },
    async setup(password, setupToken) {
      const grant = await call<AdminSessionGrant>('/api/admin/setup', {
        method: 'POST',
        body: { password, setupToken },
        authenticated: false,
      });
      csrf = grant.csrf;
    },
    async login(password) {
      const grant = await call<AdminSessionGrant>('/api/admin/login', {
        method: 'POST',
        body: { password },
        authenticated: false,
      });
      csrf = grant.csrf;
    },
    async logout() {
      await call('/api/admin/logout', { method: 'POST' });
      csrf = undefined;
    },
    async changePassword(current, next) {
      await call('/api/admin/password', { method: 'POST', body: { current, next } });
    },
    createSite: (site) => call('/api/admin/sites', { method: 'POST', body: site }),
    updateSite: (id, patch) => call(`/api/admin/sites/${id}`, { method: 'PATCH', body: patch }),
    diagnostics: () => call('/api/admin/diagnostics'),
  };
}

/** The readable half of the double-submit pair — survives a page reload. */
function csrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(/(?:^|;\s*)__Host-csrf=([^;]*)/);
  return match?.[1] === undefined || match[1] === '' ? undefined : match[1];
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON — fall through to the status line
  }
  return `request failed: ${response.status} ${response.statusText}`.trimEnd();
}
