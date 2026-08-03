import { describe, expect, it, vi } from 'vitest';
import { AdminError, createAdminClient, OFFLINE_STATUS } from './admin.ts';

interface Call {
  input: string;
  init: RequestInit | undefined;
}

function client(
  respond: (input: string, init?: RequestInit) => Response,
  onUnauthorized?: () => void,
): { admin: ReturnType<typeof createAdminClient>; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { admin: createAdminClient({ fetch: fetchImpl, onUnauthorized }), calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createAdminClient', () => {
  it('echoes the CSRF token from login on every following mutation', async () => {
    const { admin, calls } = client((input) =>
      input === '/api/admin/login'
        ? json(200, { ok: true, csrf: 'tok-123' })
        : json(201, { id: 3, name: 'X', domains: [], timezone: 'UTC' }),
    );
    await admin.login('pw');
    await admin.createSite({ name: 'X', domains: [] });

    const create = calls[1];
    expect(create?.input).toBe('/api/admin/sites');
    expect(create?.init?.method).toBe('POST');
    const headers = create?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok-123');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(create?.init?.body))).toEqual({ name: 'X', domains: [] });
  });

  it('remembers the token from me() too — a reloaded page can mutate', async () => {
    const { admin, calls } = client((input) =>
      input === '/api/admin/me'
        ? json(200, { authenticated: true, needsSetup: false, csrf: 'me-tok' })
        : json(200, { ok: true }),
    );
    await admin.me();
    await admin.logout();
    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('me-tok');
  });

  it('PATCHes site updates to the id path', async () => {
    const { admin, calls } = client(() =>
      json(200, { id: 2, name: 'Renamed', domains: [], timezone: 'UTC' }),
    );
    const site = await admin.updateSite(2, { name: 'Renamed' });
    expect(site.name).toBe('Renamed');
    expect(calls[0]?.input).toBe('/api/admin/sites/2');
    expect(calls[0]?.init?.method).toBe('PATCH');
  });

  it('DELETEs a site to the id path', async () => {
    const { admin, calls } = client(() => json(200, { ok: true }));
    await admin.deleteSite(2);
    expect(calls[0]?.input).toBe('/api/admin/sites/2');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('reports a mid-session 401 and still throws with the server message', async () => {
    const onUnauthorized = vi.fn();
    const { admin } = client(() => json(401, { error: 'unauthorized' }), onUnauthorized);
    await expect(admin.diagnostics()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does NOT report a failed login as an expired session', async () => {
    const onUnauthorized = vi.fn();
    const { admin } = client(() => json(401, { error: 'wrong password' }), onUnauthorized);
    await expect(admin.login('nope')).rejects.toThrowError('wrong password');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('exposes call() with the same CSRF echo the named methods get', async () => {
    const { admin, calls } = client((input) =>
      input === '/api/admin/login' ? json(200, { ok: true, csrf: 'tok-9' }) : json(200, []),
    );
    await admin.login('pw');
    await admin.call('/api/admin/tokens', { method: 'POST', body: { name: 'x' } });
    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok-9');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ name: 'x' });
  });

  it('turns a request the network never answered into an AdminError, not a raw fetch throw', async () => {
    // A panel must be able to tell "refused" from "never arrived"; both arrive
    // here as AdminError, so neither can be mistaken for success.
    const { admin } = client(() => {
      throw new TypeError('Failed to fetch');
    });
    const failure = await admin.call('/api/admin/tokens/4', { method: 'DELETE' }).catch((e) => e);
    expect(failure).toBeInstanceOf(AdminError);
    expect((failure as AdminError).status).toBe(OFFLINE_STATUS);
  });

  it('propagates rate-limit and non-JSON failures as AdminError', async () => {
    const limited = client(() => json(429, { error: 'too many attempts' }));
    await expect(limited.admin.login('pw')).rejects.toMatchObject({
      status: 429,
      message: 'too many attempts',
    });

    const broken = client(() => new Response('boom', { status: 500, statusText: 'Nope' }));
    const failure = await broken.admin.diagnostics().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminError);
    expect((failure as AdminError).message).toContain('500');
  });
});
