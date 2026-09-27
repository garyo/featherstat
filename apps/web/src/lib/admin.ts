import {
  type AdminDiagnostics,
  type AdminMe,
  AdminMeSchema,
  AdminSessionGrantSchema,
  type AdminSiteCreate,
  type AdminSitePatch,
  CSRF_COOKIE,
  CSRF_HEADER,
  type Dashboard,
  type DashboardDetail,
  DashboardDetailSchema,
  type DashboardInfo,
  DashboardInfoSchema,
  type ExclusionRule,
  type ExclusionState,
  type NtfySettingsInput,
  type NtfySettingsView,
  type SiteInfo,
} from '@featherstat/shared';
import { UNREADABLE_ANSWER } from './api.ts';

/**
 * The admin API client (docs/04 § 5). The session rides in HttpOnly cookies;
 * this module's only credential work is the CSRF echo: it remembers the token
 * from `me`/`login`/`setup` (falling back to the readable `csrf` cookie) and
 * sends it as `CSRF_HEADER` on every mutation — the double-submit pair.
 *
 * A 401 from any authenticated call reports to `onUnauthorized` (the app flips
 * to the login view) and still throws, so callers never see a half-result.
 *
 * Every failure leaves as an `AdminError`, including the one the network never
 * answered: a panel that cannot tell "refused" from "never arrived" tells the
 * reader an action succeeded when it did not (`admin-failure.ts` does the
 * telling).
 */

/** One zod issue from a 400, kept structured so a form can point at the field. */
export interface AdminIssue {
  path: (string | number)[];
  message: string;
}

/** The status of a request that never got one — the server was unreachable. */
export const OFFLINE_STATUS = 0;

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

/** What a response body is checked against — any zod schema from `@featherstat/shared`. */
export interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface CallInit<T> {
  method?: string;
  body?: unknown;
  /** Checks the body; without one it is trusted as `T`. */
  schema?: ResponseSchema<T>;
}

export interface AdminClientOptions {
  fetch?: typeof fetch;
  /** A session died mid-use (401 outside login) — show the login view. */
  onUnauthorized?: () => void;
}

export interface AdminClient {
  me(): Promise<AdminMe>;
  setup(password: string, setupToken: string): Promise<void>;
  /** Email absent: the instance admin's password. Present: that user's. */
  login(password: string, email?: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  createSite(site: AdminSiteCreate): Promise<SiteInfo>;
  updateSite(id: number, patch: AdminSitePatch): Promise<SiteInfo>;
  /** Tombstones the site and starts the purge of all its data — irreversible. */
  deleteSite(id: number): Promise<void>;
  diagnostics(): Promise<AdminDiagnostics>;
  /** Traffic-exclusion rules plus what the resolver has made of any hostnames. */
  exclusions(): Promise<ExclusionState>;
  /** Full-list replace; the response carries the freshly resolved hostnames. */
  saveExclusions(rules: readonly ExclusionRule[]): Promise<ExclusionState>;
  listDashboards(): Promise<DashboardInfo[]>;
  getDashboard(id: number): Promise<DashboardDetail>;
  /** `template` records which shipped template this layout was cloned from. */
  createDashboard(layout: Dashboard, template?: string): Promise<DashboardDetail>;
  updateDashboard(id: number, layout: Dashboard): Promise<DashboardDetail>;
  deleteDashboard(id: number): Promise<void>;
  /** A copy of a stored row — fresh identity, same layout and template lineage. */
  duplicateDashboard(id: number): Promise<DashboardDetail>;
  /** Rebuilds a clone from its shipped template; the server refuses rows with none. */
  resetDashboard(id: number): Promise<DashboardDetail>;
  /** Mints a read-only link; the raw token comes back exactly once (docs/04 § 5). */
  createShareLink(dashboardId: number): Promise<{ token: string }>;
  /** Revokes every live link of a dashboard — the only revoke the API offers. */
  revokeShareLinks(dashboardId: number): Promise<{ revoked: number }>;
  /**
   * The raw authenticated call (CSRF echoed, 401 reported) the code-split
   * Settings panels build their per-surface clients on (`admin-objects.ts`) —
   * so forty admin-object methods need not ride the entry chunk this module
   * is part of.
   */
  call<T>(path: string, init?: CallInit<T>): Promise<T>;
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
    init: CallInit<T> & { authenticated?: boolean } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') {
      const token = csrf ?? csrfCookie();
      if (token !== undefined) headers[CSRF_HEADER] = token;
    }
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new AdminError(OFFLINE_STATUS, 'no response');
    }
    if (response.status === 401 && (init.authenticated ?? true)) options.onUnauthorized?.();
    if (!response.ok) {
      const failure = await errorBody(response);
      throw new AdminError(response.status, failure.message, failure.issues);
    }
    const body: unknown = await response.json();
    if (init.schema === undefined) return body as T;
    const parsed = init.schema.safeParse(body);
    if (!parsed.success) throw new AdminError(response.status, UNREADABLE_ANSWER);
    return parsed.data;
  }

  return {
    async me() {
      const me = await call('/api/admin/me', { authenticated: false, schema: AdminMeSchema });
      csrf = me.csrf ?? csrf;
      return me;
    },
    async setup(password, setupToken) {
      const grant = await call('/api/admin/setup', {
        method: 'POST',
        body: { password, setupToken },
        authenticated: false,
        schema: AdminSessionGrantSchema,
      });
      csrf = grant.csrf;
    },
    async login(password, email) {
      const grant = await call('/api/admin/login', {
        method: 'POST',
        body: email === undefined || email === '' ? { password } : { password, email },
        authenticated: false,
        schema: AdminSessionGrantSchema,
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
    async deleteSite(id) {
      await call(`/api/admin/sites/${id}`, { method: 'DELETE' });
    },
    diagnostics: () => call('/api/admin/diagnostics'),
    exclusions: () => call('/api/admin/exclusions'),
    saveExclusions: (rules) => call('/api/admin/exclusions', { method: 'PUT', body: { rules } }),
    listDashboards: () => call('/api/admin/dashboards', { schema: DashboardInfoSchema.array() }),
    getDashboard: (id) => call(`/api/admin/dashboards/${id}`, { schema: DashboardDetailSchema }),
    createDashboard: (layout, template) =>
      call(
        template === undefined
          ? '/api/admin/dashboards'
          : `/api/admin/dashboards?template=${encodeURIComponent(template)}`,
        { method: 'POST', body: layout, schema: DashboardDetailSchema },
      ),
    updateDashboard: (id, layout) =>
      call(`/api/admin/dashboards/${id}`, {
        method: 'PUT',
        body: layout,
        schema: DashboardDetailSchema,
      }),
    async deleteDashboard(id) {
      await call(`/api/admin/dashboards/${id}`, { method: 'DELETE' });
    },
    duplicateDashboard: (id) =>
      call(`/api/admin/dashboards/${id}/duplicate`, {
        method: 'POST',
        schema: DashboardDetailSchema,
      }),
    resetDashboard: (id) =>
      call(`/api/admin/dashboards/${id}/reset`, { method: 'POST', schema: DashboardDetailSchema }),
    createShareLink: (dashboardId) =>
      call(`/api/admin/dashboards/${dashboardId}/share`, { method: 'POST' }),
    revokeShareLinks: (dashboardId) =>
      call(`/api/admin/dashboards/${dashboardId}/share`, { method: 'DELETE' }),
    call,
    ntfySettings: () => call('/api/admin/ntfy'),
    saveNtfySettings: (settings) => call('/api/admin/ntfy', { method: 'PUT', body: settings }),
    clearNtfySettings: () => call('/api/admin/ntfy', { method: 'DELETE' }),
    async testNtfy() {
      await call('/api/admin/ntfy/test', { method: 'POST' });
    },
  };
}

const CSRF_COOKIE_VALUE = new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`);

/** The readable half of the double-submit pair — survives a page reload. */
function csrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(CSRF_COOKIE_VALUE);
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
