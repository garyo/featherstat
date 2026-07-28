import type {
  AdminDiagnostics,
  AdminMe,
  AdminSessionGrant,
  AdminSiteCreate,
  AdminSitePatch,
  Dashboard,
  NtfySettingsInput,
  NtfySettingsView,
  SiteInfo,
} from '@analytics/shared';
import type { DashboardDetail, DashboardInfo } from './dashboards.ts';

/**
 * The admin API client (docs/04 § 5). The session rides in HttpOnly cookies;
 * this module's only credential work is the CSRF echo: it remembers the token
 * from `me`/`login`/`setup` (falling back to the readable `csrf` cookie) and
 * sends it as `x-csrf-token` on every mutation — the double-submit pair.
 *
 * A 401 from any authenticated call reports to `onUnauthorized` (the app flips
 * to the login view) and still throws, so callers never see a half-result.
 */

/** One zod issue from a 400, kept structured so a form can point at the field. */
export interface AdminIssue {
  path: (string | number)[];
  message: string;
}

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Field-level detail when the server validated a body and refused it. */
    readonly issues: AdminIssue[] = [],
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
  listDashboards(): Promise<DashboardInfo[]>;
  getDashboard(id: number): Promise<DashboardDetail>;
  createDashboard(layout: Dashboard): Promise<DashboardDetail>;
  updateDashboard(id: number, layout: Dashboard): Promise<DashboardDetail>;
  /** Mints a read-only link; the raw token comes back exactly once (docs/04 § 5). */
  createShareLink(dashboardId: number): Promise<{ token: string }>;
  /** Revokes every live link of a dashboard — the only revoke the API offers. */
  revokeShareLinks(dashboardId: number): Promise<{ revoked: number }>;
  ntfySettings(): Promise<NtfySettingsView>;
  saveNtfySettings(settings: NtfySettingsInput): Promise<NtfySettingsView>;
  /** The off switch: forgets endpoint, token and rules (a PUT cannot express it). */
  clearNtfySettings(): Promise<NtfySettingsView>;
  /** Delivers one notification now, with the saved settings; throws what ntfy said. */
  testNtfy(): Promise<void>;
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
    if (!response.ok) {
      const failure = await errorBody(response);
      throw new AdminError(response.status, failure.message, failure.issues);
    }
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
    listDashboards: () => call('/api/admin/dashboards'),
    getDashboard: (id) => call(`/api/admin/dashboards/${id}`),
    createDashboard: (layout) => call('/api/admin/dashboards', { method: 'POST', body: layout }),
    updateDashboard: (id, layout) =>
      call(`/api/admin/dashboards/${id}`, { method: 'PUT', body: layout }),
    createShareLink: (dashboardId) =>
      call(`/api/admin/dashboards/${dashboardId}/share`, { method: 'POST' }),
    revokeShareLinks: (dashboardId) =>
      call(`/api/admin/dashboards/${dashboardId}/share`, { method: 'DELETE' }),
    ntfySettings: () => call('/api/admin/ntfy'),
    saveNtfySettings: (settings) => call('/api/admin/ntfy', { method: 'PUT', body: settings }),
    clearNtfySettings: () => call('/api/admin/ntfy', { method: 'DELETE' }),
    async testNtfy() {
      await call('/api/admin/ntfy/test', { method: 'POST' });
    },
  };
}

/** The readable half of the double-submit pair — survives a page reload. */
function csrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(/(?:^|;\s*)__Host-csrf=([^;]*)/);
  return match?.[1] === undefined || match[1] === '' ? undefined : match[1];
}

async function errorBody(response: Response): Promise<{ message: string; issues: AdminIssue[] }> {
  try {
    const body = (await response.json()) as { error?: unknown; issues?: unknown };
    if (typeof body.error === 'string') {
      return { message: body.error, issues: toIssues(body.issues) };
    }
  } catch {
    // not JSON — fall through to the status line
  }
  return {
    message: `request failed: ${response.status} ${response.statusText}`.trimEnd(),
    issues: [],
  };
}

/** Narrows the server's zod issues to the two fields a form needs, shape unassumed. */
function toIssues(raw: unknown): AdminIssue[] {
  if (!Array.isArray(raw)) return [];
  const issues: AdminIssue[] = [];
  for (const entry of raw as { path?: unknown; message?: unknown }[]) {
    if (typeof entry?.message !== 'string') continue;
    const path = Array.isArray(entry.path)
      ? entry.path.filter(
          (step): step is string | number => typeof step === 'string' || typeof step === 'number',
        )
      : [];
    issues.push({ path, message: entry.message });
  }
  return issues;
}
