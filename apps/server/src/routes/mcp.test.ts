import {
  type ApiTokenMinted,
  BaseDimensionSchema,
  MetricSchema,
  type QueryResponse,
} from '@featherstat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, openTestDb, session, syncRollups, T0 } from '../../test/rows.ts';
import { createSecuredApp, type SecuredApp } from '../auth/app.ts';
import { type Db, insertEvents, upsertSessions, withWriteTransaction } from '../db/index.ts';
import { createPipeline, type Pipeline } from '../pipeline/index.ts';
import { TOKEN_BATCHES_PER_MIN } from './query.ts';

/**
 * `/mcp` (docs/04 § 6) over the raw streamable-HTTP wire: JSON-RPC POSTs with
 * `Accept: application/json, text/event-stream`, one response per POST —
 * stateless, so no session header and no handshake ordering. Auth is the same
 * Bearer token gate as `/api/query`, and the budgets are the same instances.
 */

const PASSWORD = 'a-decent-password';
const SETUP_TOKEN = 'test-setup-token';

let db: Db;
let secured: SecuredApp;
let pipeline: Pipeline;

beforeEach(() => {
  db = openTestDb(2); // sites 1 ('one.test') and 2 ('two.test')
  pipeline = createPipeline(db);
  secured = createSecuredApp({
    db,
    sink: pipeline.sink,
    pipeline,
    auth: { now: () => T0, env: {}, setupToken: SETUP_TOKEN },
  });
  withWriteTransaction(db, () => {
    insertEvents(db, [
      event({ path: '/a' }),
      event({ path: '/b', seq: 2 }),
      event({ site_id: 2, path: '/two' }),
    ]);
    upsertSessions(db, [session({ pageviews: 2, events: 0 })]);
  });
  syncRollups(db);
});

afterEach(() => {
  pipeline.shutdown();
  db.close();
});

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .join('; ');
}

async function adminSession(): Promise<{ cookie: string; csrf: string }> {
  const res = await secured.app.request('/api/admin/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, setupToken: SETUP_TOKEN }),
  });
  expect(res.status).toBe(200);
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie: cookiesOf(res), csrf };
}

async function mintToken(sites: 'all' | number[]): Promise<ApiTokenMinted> {
  const admin = await adminSession();
  const res = await secured.app.request('/api/admin/tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: admin.cookie,
      'x-csrf-token': admin.csrf,
    },
    body: JSON.stringify({ name: 'mcp token', sites }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ApiTokenMinted;
}

let rpcId = 0;

function rpcBody(method: string, params: object): string {
  rpcId += 1;
  return JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params });
}

async function rpc(token: string, method: string, params: object): Promise<Response> {
  return await secured.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: rpcBody(method, params),
  });
}

interface RpcResult {
  result?: {
    tools?: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    serverInfo?: { name: string };
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

async function resultOf(res: Response): Promise<RpcResult> {
  expect(res.status).toBe(200);
  return (await res.json()) as RpcResult;
}

/** The one text block of a tool result. */
function textOf(rpcResult: RpcResult): string {
  const text = rpcResult.result?.content?.[0]?.text;
  expect(text).toBeTypeOf('string');
  return text as string;
}

const QUERY_PARAMS = {
  name: 'query',
  arguments: {
    site: 1,
    range: { from: '2023-11-14', to: '2023-11-14' },
    queries: [{ id: 'pv', metrics: ['pageviews'] }],
  },
};

describe('auth (deny-by-default)', () => {
  it('401s anonymous callers and 403s cookie sessions — MCP is token-only', async () => {
    const anon = await secured.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody('tools/list', {}),
    });
    expect(anon.status).toBe(401);

    const admin = await adminSession();
    const cookie = await secured.app.request('/mcp', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: rpcBody('tools/list', {}),
    });
    expect(cookie.status).toBe(403);
  });

  it('answers preflights and carries CORS headers on Bearer responses', async () => {
    const preflight = await secured.app.request('/mcp', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

    const minted = await mintToken('all');
    const res = await rpc(minted.token, 'tools/list', {});
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('protocol surface', () => {
  it('initializes statelessly and lists exactly the three tools', async () => {
    const minted = await mintToken('all');
    const init = await resultOf(
      await rpc(minted.token, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      }),
    );
    expect(init.result?.serverInfo?.name).toBe('featherstat');

    // Stateless: a fresh POST with no session header still answers.
    const list = await resultOf(await rpc(minted.token, 'tools/list', {}));
    const tools = list.result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'describe_analytics',
      'query',
      'what_changed',
    ]);
    // The query tool's schema IS QueryRequestSchema, zod → JSON Schema.
    const query = tools.find((tool) => tool.name === 'query');
    expect(Object.keys(query?.inputSchema.properties ?? {}).sort()).toEqual([
      'annotations',
      'compare',
      'filters',
      'queries',
      'range',
      'site',
    ]);
  });
});

describe('describe_analytics', () => {
  it('carries the LIVE vocabulary — every metric and dimension appears', async () => {
    const minted = await mintToken('all');
    const described = await resultOf(
      await rpc(minted.token, 'tools/call', { name: 'describe_analytics', arguments: {} }),
    );
    const text = textOf(described);
    for (const metric of MetricSchema.options) expect(text).toContain(metric);
    for (const dim of BaseDimensionSchema.options) expect(text).toContain(dim);
    expect(text).toContain('one.test');
    expect(text).toContain('two.test');
  });

  it('names only the sites the token can read', async () => {
    const minted = await mintToken([1]);
    const described = await resultOf(
      await rpc(minted.token, 'tools/call', { name: 'describe_analytics', arguments: {} }),
    );
    const text = textOf(described);
    expect(text).toContain('one.test');
    expect(text).not.toContain('two.test');
  });
});

describe('query tool', () => {
  it('returns real rows through the same executor as /api/query', async () => {
    const minted = await mintToken([1]);
    const answered = await resultOf(await rpc(minted.token, 'tools/call', QUERY_PARAMS));
    expect(answered.result?.isError).toBeFalsy();
    const response = JSON.parse(textOf(answered)) as QueryResponse;
    const rows = (response.results.pv as { rows: Array<{ pageviews: number }> }).rows;
    expect(rows[0]?.pageviews).toBe(2);
    // The instance-wide write counter is the admin's alone (docs/04 § 3).
    expect(response.meta.dataVersion).toBe(0);
  });

  it('answers an out-of-scope site exactly like a nonexistent one', async () => {
    const minted = await mintToken([1]);
    const refused = await resultOf(
      await rpc(minted.token, 'tools/call', {
        name: 'query',
        arguments: { ...QUERY_PARAMS.arguments, site: 2 },
      }),
    );
    expect(refused.result?.isError).toBe(true);
    expect(textOf(refused)).toContain('unknown site');
  });

  it('runs what_changed — the changes kind plus the shared summary sentence', async () => {
    const minted = await mintToken([1]);
    const answered = await resultOf(
      await rpc(minted.token, 'tools/call', {
        name: 'what_changed',
        arguments: { site: 1, range: { from: '2023-11-14', to: '2023-11-14' } },
      }),
    );
    expect(answered.result?.isError).toBeFalsy();
    const payload = JSON.parse(textOf(answered)) as {
      summary: string;
      rows: Array<{ dim: string; value: string | null; delta: number }>;
    };
    // One visit against an empty previous day: up, and /a is among the movers.
    expect(payload.summary).toContain('one: visits up');
    expect(
      payload.rows.some((row) => row.dim === 'path' && row.value === '/a' && row.delta === 1),
    ).toBe(true);
  });

  it('scopes what_changed like everything else — out of scope reads as unknown', async () => {
    const minted = await mintToken([1]);
    const refused = await resultOf(
      await rpc(minted.token, 'tools/call', {
        name: 'what_changed',
        arguments: { site: 2, range: { preset: '7d' } },
      }),
    );
    expect(refused.result?.isError).toBe(true);
    expect(textOf(refused)).toContain('unknown site');
  });

  it('shares the token rate budget with /api/query — one budget, two surfaces', async () => {
    const minted = await mintToken([1]);
    for (let i = 0; i < TOKEN_BATCHES_PER_MIN; i += 1) {
      const ok = await resultOf(await rpc(minted.token, 'tools/call', QUERY_PARAMS));
      expect(ok.result?.isError).toBeFalsy();
    }
    const over = await resultOf(await rpc(minted.token, 'tools/call', QUERY_PARAMS));
    expect(over.result?.isError).toBe(true);
    expect(textOf(over)).toContain('too many query batches');

    // The SAME budget answers on the REST surface: the next batch there 429s.
    const rest = await secured.app.request('/api/query', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${minted.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(QUERY_PARAMS.arguments),
    });
    expect(rest.status).toBe(429);
  });
});
