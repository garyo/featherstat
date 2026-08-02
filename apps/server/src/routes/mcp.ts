import {
  BaseDimensionSchema,
  BucketSchema,
  ENGAGEMENT_THRESHOLD_MS,
  FilterOpSchema,
  GOAL_ASPECTS,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  MAX_QUERIES_PER_BATCH,
  MetricSchema,
  PING_CLAMP_MS,
  type QueryRequest,
  QueryRequestSchema,
  type QueryResponse,
  RangePresetSchema,
  SESSION_ONLY_DIMENSIONS,
} from '@featherstat/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { Auth, AuthEnv } from '../auth/auth.ts';
import { canReadSite, type Principal, readableSites } from '../auth/principal.ts';
import { type Db, listDerivedMetrics, listGoals, listPropKeys, listSites } from '../db/index.ts';
import { executeQueryRequest, UnknownSiteError } from '../query/executor.ts';
import { PoolSaturatedError } from '../query/pool/pool.ts';
import { expandSegments, resolveDerived, resolveGoals } from '../query/stored.ts';
import {
  createQueryRateLimits,
  type ExecuteQuery,
  QUERY_WINDOW_MS,
  type QueryRateLimits,
} from './query.ts';

/**
 * `/mcp` — the MCP surface (docs/04 § 6): an analyst points their LLM at the
 * instance with an ordinary API token and it composes queries in the same
 * closed vocabulary as everyone else. Two tools, deliberately few — the
 * vocabulary is the product, and no free text ever becomes SQL (invariant 9):
 *
 * - `describe_analytics` — the vocabulary as a document the model reads once,
 *   pulled LIVE from the shared enums and the DB so it cannot drift.
 * - `query` — input schema IS `QueryRequestSchema`; executes through the same
 *   expansion, scoping, rate-limit and ExecuteQuery path as `/api/query`.
 *
 * Token-only by design: Bearer tokens carry no ambient credential, so there is
 * no CSRF question, and a cookie session pointed here is a mistake to surface
 * (403), never to accommodate. Stateless streamable HTTP: each POST constructs
 * its own server + transport (`sessionIdGenerator: undefined`), so the surface
 * holds no session state and a load balancer needs no affinity.
 */

const SERVER_INFO = { name: 'featherstat', version: '2.0.0' };

export interface McpRouteOptions {
  execute?: ExecuteQuery;
  /** Shared with `/api/query` by the ops shell — one token budget across both. */
  limits?: QueryRateLimits;
  now?: () => number;
}

export function createMcpRoutes(db: Db, auth: Auth, options: McpRouteOptions = {}): Hono<AuthEnv> {
  const execute: ExecuteQuery =
    options.execute ??
    ((request, now, allowedSites, derived, goals) =>
      executeQueryRequest(db, request, { now, allowedSites, derived, goals }));
  const limits = options.limits ?? createQueryRateLimits();
  const now = options.now ?? Date.now;

  const app = new Hono<AuthEnv>();
  // Born authenticated (deny-by-default): the gate 401s anonymous callers, and
  // the only principal MCP speaks for is a token — cookies 403 (documented).
  app.use('/mcp', auth.gate);
  app.use('/mcp', async (c, next) => {
    if (c.get('principal')?.kind !== 'token') {
      return c.json({ error: 'MCP is token-only — send Authorization: Bearer fs_<token>' }, 403);
    }
    await next();
  });

  app.all('/mcp', async (c) => {
    const who = c.get('principal');
    if (who.kind !== 'token') return c.json({ error: 'MCP is token-only' }, 403); // unreachable
    const server = buildServer(db, who, execute, limits, now);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — every POST stands alone
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}

function buildServer(
  db: Db,
  who: Extract<Principal, { kind: 'token' }>,
  execute: ExecuteQuery,
  limits: QueryRateLimits,
  now: () => number,
): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'describe_analytics',
    {
      description:
        'The featherstat query vocabulary: the sites this token can read, every metric and ' +
        'dimension, the filter grammar, ranges, compare forms and metric semantics. Read this ' +
        'once before composing query calls.',
    },
    () => ({
      content: [{ type: 'text', text: describeAnalytics(db, who) }],
    }),
  );

  server.registerTool(
    'query',
    {
      description:
        'Run a batched analytics query — the exact same request shape as POST /api/query. ' +
        'Call describe_analytics first for the vocabulary. Per-query {error} entries are ' +
        'honest refusals: the combination cannot be answered correctly, not a server fault.',
      inputSchema: QueryRequestSchema,
    },
    async (request: QueryRequest) => {
      const expansion = expandSegments(db, request);
      if (!expansion.ok) return refusal(expansion.message);
      const expanded = expansion.request;
      const derived = resolveDerived(db, expanded);
      const goals = resolveGoals(db, expanded);
      // The SAME budget as /api/query, keyed identically — one token, one
      // budget across both surfaces. Charged before the work, like the route.
      const key = `token:${who.tokenId}`;
      const at = now();
      if (limits.token.exhausted(key, at) || limits.global.exhausted('*', at)) {
        return refusal(`too many query batches — try again in ${QUERY_WINDOW_MS / 1000} seconds`);
      }
      limits.token.charge(key, at);
      limits.global.charge('*', at);
      const allowedSites = readableSites(
        who,
        listSites(db).map((site) => site.id),
      );
      let response: QueryResponse;
      try {
        response = await execute(expanded, at, allowedSites, derived, goals);
      } catch (error) {
        // Out of scope answers exactly like nonexistent, here as everywhere.
        if (error instanceof UnknownSiteError) return refusal(error.message);
        if (error instanceof PoolSaturatedError) {
          return refusal('the query pool is saturated — try again in a minute');
        }
        throw error;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );

  return server;
}

/** A refusal the model can learn from — an MCP tool error, never a thrown 500. */
function refusal(message: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The vocabulary document. Everything enumerable comes from the LIVE shared
 * enums and DB rows — never restated by hand — so it cannot drift from what
 * the query route accepts; mcp.test.ts asserts every enum option appears.
 */
export function describeAnalytics(db: Db, who: Extract<Principal, { kind: 'token' }>): string {
  const sites = listSites(db).filter((site) => canReadSite(who, site.id));
  const siteLines = sites.map(
    (site) =>
      `- ${site.id}: ${site.name} (${site.domains.join(', ') || 'no domains'}, tz ${site.timezone})`,
  );

  const goalLines = sites.flatMap((site) =>
    listGoals(db, site.id).map(
      (goal) =>
        `- goal:${goal.id}:<aspect> — '${goal.name}' on site ${site.id}; aspects: ${GOAL_ASPECTS.join(', ')}`,
    ),
  );
  const derivedLines = listDerivedMetrics(db).map((row) => `- d:${row.name} = ${row.expr}`);
  const propLines = sites.flatMap((site) =>
    listPropKeys(db, site.id).map((row) => `- prop:${row.key} (site ${site.id})`),
  );

  return `# featherstat analytics — query vocabulary

Everything is a POST-shaped batch: { site, range, compare?, filters?, queries: [...] }
(up to ${MAX_QUERIES_PER_BATCH} queries per call). 'site' is a site id or "all"
(= all sites this token can read). Results come back per query id; a query the
vocabulary cannot answer honestly returns a per-query {error} instead of wrong
numbers — read the message, it names the rule.

## Sites this token reads
${siteLines.join('\n') || '- (none)'}

## Metrics
${MetricSchema.options.join(', ')}
${goalLines.length > 0 ? `\nGoal metrics (per-goal, format goal:<id>:<aspect>):\n${goalLines.join('\n')}` : ''}
${derivedLines.length > 0 ? `\nDerived metrics (stored arithmetic, format d:<name>):\n${derivedLines.join('\n')}` : ''}

## Dimensions ('dim', optional 'dim2')
${BaseDimensionSchema.options.join(', ')}
${propLines.length > 0 ? `\nCustom-prop dimensions in use (format prop:<key>, event-only):\n${propLines.join('\n')}` : ''}

## Filters
'filters' (on the request or a query) is an array of filter nodes, implicit AND.
A node is a leaf { dim, op, value?, scope? } or a composite { all: [...] },
{ any: [...] }, { not: node }, { segment: <id> } (a saved segment ref).
Depth <= ${MAX_FILTER_DEPTH}, <= ${MAX_FILTER_LEAVES} leaves in total.
Ops: ${FilterOpSchema.options.join(', ')}. 'is_null' takes no value (it names the
NULL group, e.g. direct traffic under ref_domain); 'glob' is an SQLite glob
pattern. scope: "hit" (default) matches the row; scope: "session" matches
sessions containing >=1 non-ping event matching the leaf.

## Ranges and buckets
range: { preset } with preset one of ${RangePresetSchema.options.join(', ')} — or
{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" } (inclusive site-local dates). '24h' is
the one rolling preset. bucket: ${BucketSchema.options.join(', ')} groups a
query into a time series.

## Compare
compare: "previous" | "year" | { segment: <id> } (same window through a saved
segment's filter) | { from, to } (explicit window; unequal lengths align by
index from the start and meta.windows labels the mismatch).

## Other query kinds (same batch envelope)
- { kind: "transitions", steps } / { kind: "flows", steps, limit } — journey edges / top session paths
- { kind: "adjacency", path, direction: "in"|"out" } — what came just before/after one page
- { kind: "dwell", path?, limit } — time on page over measured page legs
- { kind: "distribution", of: "dwell"|"scroll", path? } — fixed-bucket histograms

## Semantics worth knowing
- bounce_rate is engagement-aware: a single-page session with >= ${ENGAGEMENT_THRESHOLD_MS / 1000}s
  of engaged time is NOT a bounce.
- engaged_ms is accrued attention: every event (heartbeat pings included)
  credits its gap to the session, clamped at ${PING_CLAMP_MS / 1000}s per gap.
- visitors is a distinct count over a daily-rotating id (approximate across
  days, mark it '~'): per-day distincts are exact, but distinct counts have NO
  total across buckets — never sum them.
- session-only dimensions (${SESSION_ONLY_DIMENSIONS.join(', ')}) refuse
  event-level metrics; event-only dimensions refuse session metrics; goal
  metrics refuse hour buckets. These refusals arrive as per-query {error}
  entries — rephrase the question, don't retry the same one.
- rates are fractions in 0..1, never pre-scaled percentages.
`;
}
