import {
  allSitesTemplate,
  collectBatch,
  type Dashboard,
  hourlyWhenIntraday,
  isQueryError,
  overviewTemplate,
  type Query,
  type QueryRequest,
  type QueryResponse,
  type QueryResult,
  type RangePreset,
  type WidgetSpec,
} from '@featherstat/shared';
import type { Db } from '../../apps/server/src/db/index.ts';
import { executeQueryRequest } from '../../apps/server/src/query/executor.ts';
import { generateCorpus } from '../../apps/server/test/replay/generate.ts';
import { openReplayDb } from '../../apps/server/test/replay/harness.ts';

// The dashboards the web app actually ships, from the shared template registry.
const siteOverview = overviewTemplate.build(1);
const allSites = (siteIds: readonly number[]): Dashboard => allSitesTemplate.build('all', siteIds);

/**
 * Real server answers for the dashboards the web app actually ships.
 *
 * The web's derivations were tested against hand-written literals, which cannot
 * tell a right denominator from a wrong one: the fixture and the code were
 * written by the same hand at the same moment, so a metric that changed
 * population under them would move both and be caught by neither. Here the
 * bodies come out of the real compiler and executor, over the replay corpus,
 * through the same `collectBatch` a view and the share route both call.
 *
 * The replay corpus and NOT captured production traffic (P4, revised): captures
 * would carry real visitor data into the repo and go stale on every vocabulary
 * change, and there would be nothing to check the answers against. This corpus
 * is generated, deterministic, and carries its own independent bookkeeping.
 *
 * Three weeks rather than the replay suites' ninety days: this asks whether the
 * seam holds, not whether the numbers scale — and the whole suite pays for the
 * ingest.
 */

const CORPUS_DAYS = 21;
const DAY_MS = 86_400_000;

/** deep-timeline.org — deliberately not UTC, so a timezone bug has room to show. */
export const CONTRACT_SITE = 4;

export const corpus = generateCorpus({ days: CORPUS_DAYS });

/**
 * The clock every request here resolves against: midday of the corpus's last
 * day, so `DEFAULT_RANGE` lands wholly INSIDE the traffic. Pinned, because
 * `Date.now()` in a test is a bug waiting for a Tuesday — and because a window
 * that runs off the front of the corpus makes half these assertions vacuous
 * (a slice with no visits has no bounce rate to re-weight and no previous
 * period to compare against, so tiles legitimately go blank).
 */
export const NOW = corpus.endMs - DAY_MS / 2;

/** Seven days ending inside the corpus: every bucket carries traffic. */
const DEFAULT_RANGE: RangePreset = '7d';

let cached: Db | undefined;

export function contractDb(): Db {
  cached ??= openReplayDb(corpus);
  return cached;
}

export function closeContractDb(): void {
  cached?.close();
  cached = undefined;
}

export interface Answered {
  dashboard: Dashboard;
  request: QueryRequest;
  response: QueryResponse;
}

/**
 * The batch a view would send for this dashboard. Everything about it is the
 * app's: the widgets' own declared queries, their derived companions, the hourly
 * rewrite under `today`, and the previous-period compare a dashboard asks for —
 * assembled by `packages/shared`, which is the whole point of it being there
 * (the share route builds the identical body server-side).
 */
export function requestFor(
  dashboard: Dashboard,
  options: { range?: RangePreset; site?: QueryRequest['site'] } = {},
): QueryRequest {
  const range = options.range ?? DEFAULT_RANGE;
  return {
    site: options.site ?? dashboard.site,
    range: { preset: range },
    compare: 'previous',
    queries: hourlyWhenIntraday(collectBatch(dashboard).queries, range),
  };
}

/** That batch, executed against the corpus at the pinned clock. */
export function answer(
  dashboard: Dashboard,
  options: { range?: RangePreset; site?: QueryRequest['site'] } = {},
): Answered {
  const request = requestFor(dashboard, options);
  return { dashboard, request, response: executeQueryRequest(contractDb(), request, { now: NOW }) };
}

/** The shipped site dashboard, answered for a real site. */
export function siteAnswer(
  site: QueryRequest['site'] = CONTRACT_SITE,
  range?: RangePreset,
): Answered {
  return answer(siteOverview, { range, site });
}

/** The shipped all-sites dashboard, answered across every site of the corpus. */
export function allSitesAnswer(range?: RangePreset): Answered {
  return answer(allSites(corpus.sites.map((site) => site.id)), { range });
}

export function widgetOf(dashboard: Dashboard, id: string): WidgetSpec {
  const spec = dashboard.grid.find((widget) => widget.id === id);
  if (spec === undefined) throw new Error(`no '${id}' widget on '${dashboard.name}'`);
  return spec;
}

/** The metric query a widget declared — narrowed, so a caller can read `metrics`. */
export function metricQueryOf(spec: WidgetSpec): Extract<Query, { metrics: string[] }> {
  const query = spec.query;
  if (query === undefined || 'kind' in query) {
    throw new Error(`widget '${spec.id}' declares no metric query`);
  }
  return query;
}

/**
 * One widget's slice of the answer, by slot — the routing a view does
 * (`views/batch.ts`), done here so a contract test reads results the way a
 * widget receives them rather than by guessing a query id.
 */
export function sliceOf(
  { dashboard, response }: Answered,
  widget: string,
  slot = 'main',
): QueryResult {
  const id = collectBatch(dashboard).slots.get(widget)?.[slot];
  if (id === undefined) throw new Error(`widget '${widget}' has no '${slot}' slot`);
  const entry = response.results[id];
  if (entry === undefined || isQueryError(entry)) {
    throw new Error(`'${widget}.${slot}' (${id}) answered ${JSON.stringify(entry)}`);
  }
  return entry;
}
