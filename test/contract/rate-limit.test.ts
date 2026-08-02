import type { QueryRequest, RangePreset } from '@featherstat/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/server/src/index.ts';
import {
  QUERY_BATCHES_GLOBAL,
  QUERY_BATCHES_PER_SESSION,
  QUERY_WINDOW_MS,
  TOKEN_BATCHES_PER_MIN,
} from '../../apps/server/src/routes/query.ts';
import { allSites } from '../../apps/web/src/dashboards/all-sites.ts';
import { siteOverview } from '../../apps/web/src/dashboards/site-overview.ts';
import { canonicalJson } from '../../apps/web/src/lib/api.ts';
import { REVALIDATE_DEBOUNCE_MS } from '../../apps/web/src/lib/live.ts';
import { CONTRACT_SITE, closeContractDb, contractDb, corpus, NOW, requestFor } from './corpus.ts';

/**
 * The `/api/query` budget against the cadence the client actually produces.
 *
 * A rate limit is easy to prove strict and hard to prove safe, and only one of
 * those failures is visible to a reader: a limit that trips on ordinary use
 * blanks a dashboard for a minute at a time. The budget lives in
 * `apps/server`; the cadence that must fit inside it lives in `apps/web`
 * (`REVALIDATE_DEBOUNCE_MS`, plus one batch per view state — invariant 1). Two
 * numbers in two packages that have to agree is exactly the seam this suite
 * exists for, so the shipped dashboards are driven at the shipped cadence
 * against the real route.
 *
 * `routes/query.test.ts` covers the other half — that the limit trips at all,
 * what it answers, and what it is keyed on.
 *
 * Requests go out unconditionally, with no `If-None-Match`. That is the worst
 * case and the honest one: on a live instance the ETag hashes a data version
 * that moves with every flush, so a revalidation almost always executes. A test
 * that let the client's ETag cache answer would pass on 304s that cost nothing
 * and prove nothing.
 */

/**
 * How many live views one reader may keep open — tabs on two dashboards, a
 * second monitor, a wall display. Each is an independent revalidation timer, and
 * they all bill to the one session.
 */
const VIEWS_HELD_OPEN = 6;
/** Windows to sustain the live cadence for, so the sliding window is crossed, not skirted. */
const SUSTAINED_WINDOWS = 3;
/** A deploy restarts the process; every open tab reconnects and re-queries at once. */
const TABS_RETURNING = 12;

const PRESETS: readonly RangePreset[] = ['today', '24h', '7d', '30d', '90d'];

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  // A fresh app per test: the limiters are per-router state, and a budget
  // carried between tests would make them depend on their order.
  app = createApp({ db: contractDb() });
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
  closeContractDb();
});

async function batch(request: QueryRequest): Promise<Response> {
  return await app.request('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: canonicalJson(request),
  });
}

/** Every response of a legitimate pattern, so a failure names the one that broke. */
async function statuses(requests: readonly QueryRequest[]): Promise<number[]> {
  const seen: number[] = [];
  for (const request of requests) seen.push((await batch(request)).status);
  return seen;
}

const allOk = (seen: readonly number[]): void => {
  expect(seen.filter((status) => status !== 200)).toEqual([]);
};

/**
 * Saturated API tokens the global bucket must absorb WHILE the live views above
 * keep revalidating. Tokens have no shipped client whose cadence could drive
 * them here — a token is someone else's script — so their row is arithmetic:
 * the token class (routes/query.ts TOKEN_BATCHES_PER_MIN) shares the one global
 * bucket, and sizing that bucket must leave the interactive traffic room even
 * with this many extraction scripts running flat out.
 */
const TOKENS_SATURATED = 4;

describe('the query budget accommodates the client that shares it', () => {
  it('leaves room for every live view a reader can hold open', () => {
    // The arithmetic the driven tests below rest on, asserted directly so a
    // change to either number fails here first and says which way it went.
    const perViewPerWindow = QUERY_WINDOW_MS / REVALIDATE_DEBOUNCE_MS;
    expect(perViewPerWindow * VIEWS_HELD_OPEN).toBeLessThanOrEqual(QUERY_BATCHES_PER_SESSION);
  });

  it('leaves the global bucket room for saturated tokens beside the live views', () => {
    // The token row: a machine's budget never exceeds a human's, and a few
    // machines at full tilt must not starve the dashboards they run beside.
    expect(TOKEN_BATCHES_PER_MIN).toBeLessThanOrEqual(QUERY_BATCHES_PER_SESSION);
    const perViewPerWindow = QUERY_WINDOW_MS / REVALIDATE_DEBOUNCE_MS;
    const interactive = perViewPerWindow * VIEWS_HELD_OPEN;
    expect(interactive + TOKENS_SATURATED * TOKEN_BATCHES_PER_MIN).toBeLessThanOrEqual(
      QUERY_BATCHES_GLOBAL,
    );
  });

  it('does not trip on one batch per view state, at the rate a hand can produce them', async () => {
    // Invariant 1: a view state is one batch. A reader working hard — a range,
    // then a filter, then a site, twice a second for a full window — is still
    // an order of magnitude below anything the limiter reacts to.
    const requests: QueryRequest[] = [];
    for (const range of PRESETS) {
      requests.push(requestFor(siteOverview, { range, site: CONTRACT_SITE }));
      requests.push(requestFor(allSites(corpus.sites.map((site) => site.id)), { range }));
    }
    const seen: number[] = [];
    for (let i = 0; i < requests.length; i += 1) {
      vi.setSystemTime(NOW + i * 500);
      const request = requests[i];
      if (request === undefined) throw new Error('unreachable');
      seen.push((await batch(request)).status);
    }
    allOk(seen);
  });

  it('does not trip on a live dashboard revalidating as the clock turns', async () => {
    // One view, revalidating at the debounce for three full windows, every tick
    // executing. This is the pattern that would break first if the budget were
    // set by intuition rather than by this number.
    const request = requestFor(siteOverview, { range: 'today', site: CONTRACT_SITE });
    const ticks = (SUSTAINED_WINDOWS * QUERY_WINDOW_MS) / REVALIDATE_DEBOUNCE_MS;
    const seen: number[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      vi.setSystemTime(NOW + tick * REVALIDATE_DEBOUNCE_MS);
      seen.push((await batch(request)).status);
    }
    expect(seen).toHaveLength(ticks);
    allOk(seen);
  });

  it('does not trip on the reconnect burst after a deploy', async () => {
    // The stream drops, every open tab reconnects, and `createRevalidator` arms
    // on `reconnect` because version ticks during the gap are gone — so the
    // whole fleet re-queries in the same instant, all of it billed to one
    // session. The clock does not move: this is a burst, not a rate.
    const sites = corpus.sites.map((site) => site.id);
    const returning: QueryRequest[] = Array.from({ length: TABS_RETURNING }, (_, tab) =>
      tab % 2 === 0
        ? requestFor(siteOverview, { range: 'today', site: sites[tab % sites.length] ?? 1 })
        : requestFor(allSites(sites), { range: '30d' }),
    );
    allOk(await statuses(returning));
  });
});
