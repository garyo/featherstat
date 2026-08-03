import {
  CHANGES_DIMENSIONS,
  isQueryError,
  type QueryErrorResult,
  type QueryRequest,
  type QueryResponse,
  type QueryResult,
} from '@featherstat/shared';
import { type Db, getSetting, listSites, setSetting, withWriteTransaction } from '../db/index.ts';
import { type ChangesMover, moversOf, summarizeChanges } from '../query/changes.ts';
import { executeQueryRequest } from '../query/executor.ts';
import type { AlertNotifier } from './alerts.ts';

/**
 * The weekly digest (docs/04 § 5): one ntfy notification, one sentence per
 * site — this week's visits against last week's, with the top movers from a
 * `changes`-kind query named as what drove it. The sentence itself comes from
 * `summarizeChanges` in query/changes.ts, the SAME formatter the MCP
 * `what_changed` tool uses, so the two can never phrase a movement differently.
 *
 * Scheduled weekly with its last run persisted in a settings row (the pattern
 * the GeoIP job uses with its file mtime): a restart mid-week does not re-send,
 * and a server down over the boundary sends at the next boot.
 */

export const DIGEST_LAST_RUN_KEY = 'digest_last_run';
export const DIGEST_TITLE = 'Weekly analytics digest';

/** How many movers each dimension contributes to a site's sentence pool. */
const DIGEST_MOVERS_PER_DIM = 3;

export function digestLastRunAt(db: Db): number | undefined {
  const raw = getSetting(db, DIGEST_LAST_RUN_KEY);
  const at = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(at) ? at : undefined;
}

export interface DigestOptions {
  now?: () => number;
  /** Injectable for tests; defaults to the in-process executor. */
  execute?: (request: QueryRequest, now: number) => QueryResponse;
}

export interface DigestResult {
  /** ntfy is unconfigured — nothing was computed or sent, and no run recorded. */
  skipped: boolean;
  sites: number;
  body: string;
}

export function runDigest(
  db: Db,
  notify: AlertNotifier,
  options: DigestOptions = {},
): DigestResult {
  if (!notify.configured()) return { skipped: true, sites: 0, body: '' };
  const now = options.now?.() ?? Date.now();
  const execute =
    options.execute ?? ((request, at) => executeQueryRequest(db, request, { now: at }));

  const lines: string[] = [];
  for (const site of listSites(db)) {
    const response = execute(digestRequest(site.id), now);
    const line = siteLine(site.name, response);
    if (line !== undefined) lines.push(line);
  }
  const body = lines.join('\n');
  if (lines.length > 0) notify.post('digest', DIGEST_TITLE, body, 0);
  withWriteTransaction(db, () => setSetting(db, DIGEST_LAST_RUN_KEY, String(now)));
  return { skipped: false, sites: lines.length, body };
}

/** 7 days vs the 7 before, all four dimensions, three movers each. */
export function digestRequest(siteId: number): QueryRequest {
  return {
    site: siteId,
    range: { preset: '7d' },
    compare: 'previous',
    queries: [
      {
        id: 'changes',
        kind: 'changes',
        metric: 'visits',
        dims: [...CHANGES_DIMENSIONS],
        limit: DIGEST_MOVERS_PER_DIM,
      },
      { id: 'kpis', metrics: ['visits'] },
    ],
  };
}

/** One site's sentence, or nothing when its numbers cannot be read honestly. */
function siteLine(siteName: string, response: QueryResponse): string | undefined {
  const kpis = response.results.kpis;
  const changes = response.results.changes;
  if (kpis === undefined || isQueryError(kpis)) return undefined;
  const current = totalOf(kpis.rows[0]);
  const previous = totalOf(kpis.compare?.[0]);
  if (current === null || previous === null) return undefined;
  return summarizeChanges(siteName, 'visits', current, previous, changeMovers(changes));
}

function changeMovers(entry: QueryResult | QueryErrorResult | undefined): ChangesMover[] {
  return entry === undefined || isQueryError(entry) ? [] : moversOf(entry.rows);
}

function totalOf(row: Record<string, unknown> | undefined): number | null {
  const value = row?.visits;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
