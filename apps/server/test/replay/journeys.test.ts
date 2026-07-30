import {
  type Hit,
  PING_CLAMP_MS,
  type QueryRequest,
  SESSION_REVIVAL_MS,
  SESSION_TIMEOUT_MS,
} from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/index.ts';
import { executeQueryRequest } from '../../src/query/executor.ts';
import { resultOf } from '../rows.ts';
import { BOT_AGENTS, type Corpus, generateCorpus, localStamp } from './generate.ts';
import { openReplayDb } from './harness.ts';

/**
 * Journeys acceptance (M2, docs/08): sequence queries over the 90-day replay
 * corpus must agree with an oracle that never touches SQL — it re-sessionizes
 * the generator's raw hit stream in plain JS (docs/03 rules: identity with the
 * site-local midnight rotation, 30-min idle timeout, clamped engagement) and derives
 * transitions/flows by grouping each session's ordered non-ping steps, with
 * consecutive repeats of one label collapsed into a single step.
 */

const corpus = generateCorpus();

/** Wide enough to hold every local date the corpus can produce, in any site timezone. */
const FULL_RANGE = { from: '2026-02-14', to: '2026-05-17' } as const;

let db: Db;
let oracle: OracleSession[];

beforeAll(() => {
  db = openReplayDb(corpus);
  oracle = sessionize(corpus);
}, 120_000);

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

interface OracleSession {
  siteId: number;
  localDate: string;
  lastSeen: number;
  engagedMs: number;
  /** Ordered non-ping step labels, exactly as the server would label them. */
  steps: string[];
  /** Non-ping rows before the collapse — what makes the check below non-vacuous. */
  rows: number;
}

const BOT_AGENT_SET = new Set(BOT_AGENTS);

function sessionize(source: Corpus): OracleSession[] {
  const zones = new Map(source.sites.map((site) => [site.id, site.timezone]));
  const open = new Map<string, OracleSession>();
  const all: OracleSession[] = [];
  for (const { hit, ctx } of source.hits) {
    if (BOT_AGENT_SET.has(ctx.userAgent)) continue;
    // Identity rotates at site-local midnight (docs/03), so the local date is part of the key.
    const localDate = localStamp(zones.get(hit.siteId) ?? 'UTC', ctx.receivedAt).date;
    const identity = `${hit.siteId}|${localDate}|${hit.visitorId ?? `${ctx.ip}\n${ctx.userAgent}`}`;
    // A ping continues a visit, never starts one (docs/03): it reaches back to the
    // returning-reader window, and past that it is dropped rather than stored.
    const prior = open.get(identity);
    const reach = hit.type === 'ping' ? SESSION_REVIVAL_MS : SESSION_TIMEOUT_MS;
    const idle = prior === undefined ? Number.POSITIVE_INFINITY : ctx.receivedAt - prior.lastSeen;
    if (hit.type === 'ping' && idle > reach) continue;
    let session = idle <= reach ? prior : undefined;
    if (session === undefined) {
      session = {
        siteId: hit.siteId,
        localDate,
        lastSeen: ctx.receivedAt,
        engagedMs: 0,
        steps: [],
        rows: 0,
      };
      open.set(identity, session);
      all.push(session);
    } else {
      const gap = ctx.receivedAt - session.lastSeen;
      session.engagedMs += Math.min(Math.max(gap, 0), PING_CLAMP_MS);
      session.lastSeen = ctx.receivedAt;
    }
    // Consecutive identical labels are one step: a journey is movement between
    // pages, so a reload or an SPA double-fire adds nothing (docs/03 § Journeys).
    if (hit.type !== 'ping') {
      const step = label(hit);
      session.rows += 1;
      if (step !== session.steps.at(-1)) session.steps.push(step);
    }
  }
  return all;
}

/** The server's labelling rule, restated: path for page-ish hits, category · action for events. */
function label(hit: Hit): string {
  if (hit.type === 'event') {
    return hit.event === undefined ? '' : `event: ${hit.event.category} · ${hit.event.action}`;
  }
  if (hit.url === undefined) return '';
  const url = new URL(hit.url);
  return url.pathname + url.search;
}

interface Envelope {
  site: number;
  from: string;
  to: string;
  /** strftime('%w') numbering: 0 = Sunday … 6 = Saturday. */
  weekday?: number;
}

function scopedSessions(envelope: Envelope): OracleSession[] {
  return oracle.filter(
    (session) =>
      session.siteId === envelope.site &&
      session.localDate >= envelope.from &&
      session.localDate <= envelope.to &&
      (envelope.weekday === undefined || weekdayOf(session.localDate) === envelope.weekday),
  );
}

function weekdayOf(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

interface Edge {
  step: number;
  from: string;
  to: string;
  sessions: number;
}

function expectedTransitions(
  scoped: readonly OracleSession[],
  steps: number,
  limit: number,
): Edge[] {
  const counts = new Map<string, Edge>();
  for (const session of scoped) {
    for (let k = 0; k + 1 < session.steps.length && k < steps; k += 1) {
      const from = session.steps[k] ?? '';
      const to = session.steps[k + 1] ?? '';
      const key = `${k}\u0000${from}\u0000${to}`;
      const edge = counts.get(key);
      if (edge === undefined) counts.set(key, { step: k + 1, from, to, sessions: 1 });
      else edge.sessions += 1;
    }
  }
  const byStep = new Map<number, Edge[]>();
  for (const edge of counts.values()) {
    const layer = byStep.get(edge.step);
    if (layer === undefined) byStep.set(edge.step, [edge]);
    else layer.push(edge);
  }
  const rows: Edge[] = [];
  for (const step of [...byStep.keys()].sort((a, b) => a - b)) {
    const layer = (byStep.get(step) ?? [])
      .sort((a, b) => b.sessions - a.sessions || cmp(a.from, b.from) || cmp(a.to, b.to))
      .slice(0, limit);
    rows.push(...layer);
  }
  return rows;
}

interface Flow {
  steps: string[];
  sessions: number;
  avg_engaged_ms: number;
  exit_rate: number;
}

function expectedFlows(scoped: readonly OracleSession[], steps: number, limit: number): Flow[] {
  const groups = new Map<
    string,
    { sig: string[]; sessions: number; engaged: number; exits: number }
  >();
  for (const session of scoped) {
    if (session.steps.length === 0) continue; // a session of only pings has no journey
    const sig = session.steps.slice(0, steps);
    const key = JSON.stringify(sig);
    let group = groups.get(key);
    if (group === undefined) {
      group = { sig, sessions: 0, engaged: 0, exits: 0 };
      groups.set(key, group);
    }
    group.sessions += 1;
    group.engaged += session.engagedMs;
    if (session.steps.length <= steps) group.exits += 1;
  }
  return [...groups.entries()]
    .sort(([keyA, a], [keyB, b]) => b.sessions - a.sessions || cmp(keyA, keyB))
    .slice(0, limit)
    .map(([, group]) => ({
      steps: group.sig,
      sessions: group.sessions,
      avg_engaged_ms: group.engaged / group.sessions,
      exit_rate: group.exits / group.sessions,
    }));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sequenceBatch(
  envelope: Envelope,
  steps: number,
  limit: number,
  filters?: QueryRequest['filters'],
): QueryRequest {
  return {
    site: envelope.site,
    range: { from: envelope.from, to: envelope.to },
    ...(filters === undefined ? {} : { filters }),
    queries: [
      { id: 'sankey', kind: 'transitions', steps, limit },
      { id: 'journeys', kind: 'flows', steps, limit },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sequence queries on the replay corpus', () => {
  it('oracle sessionization agrees with the generator day totals', () => {
    const bySiteDay = new Map<string, number>();
    for (const session of oracle) {
      const key = `${session.siteId}|${session.localDate}`;
      bySiteDay.set(key, (bySiteDay.get(key) ?? 0) + 1);
    }
    for (const day of corpus.totals) {
      expect(bySiteDay.get(`${day.siteId}|${day.localDate}`) ?? 0).toBe(day.sessions);
    }
  });

  it('transitions match the oracle for every site over the full range', () => {
    for (const site of corpus.sites) {
      const envelope = { site: site.id, ...FULL_RANGE };
      const response = executeQueryRequest(db, sequenceBatch(envelope, 4, 200));
      const expected = expectedTransitions(scopedSessions(envelope), 4, 200);
      expect(expected.length, site.name).toBeGreaterThan(0);
      expect(resultOf(response, 'sankey').rows, site.name).toEqual(expected);
    }
  });

  it('flows match the oracle for every site over the full range', () => {
    for (const site of corpus.sites) {
      const envelope = { site: site.id, ...FULL_RANGE };
      const response = executeQueryRequest(db, sequenceBatch(envelope, 4, 200));
      const expected = expectedFlows(scopedSessions(envelope), 4, 200);
      expect(expected.length, site.name).toBeGreaterThan(0);
      expect(resultOf(response, 'journeys').rows, site.name).toEqual(expected);
    }
  });

  it('collapses consecutive repeats, and the corpus has plenty to collapse', () => {
    // Anti-vacuity first: without repeats in the data, agreeing with an oracle
    // that collapses them would say nothing at all.
    const rows = oracle.reduce((total, session) => total + session.rows, 0);
    const steps = oracle.reduce((total, session) => total + session.steps.length, 0);
    expect(steps, 'no repeat anywhere — the collapse is untested').toBeLessThan(rows);
    expect(oracle.filter((session) => session.steps.length < session.rows).length).toBeGreaterThan(
      0,
    );

    // And the shape it guarantees, straight off the engine: a journey never
    // steps from a label to itself, in either kind.
    for (const site of corpus.sites) {
      const response = executeQueryRequest(
        db,
        sequenceBatch({ site: site.id, ...FULL_RANGE }, 4, 200),
      );
      const edges = resultOf(response, 'sankey').rows;
      expect(edges.length, site.name).toBeGreaterThan(0);
      expect(
        edges.filter((row) => row.from === row.to),
        site.name,
      ).toEqual([]);
      for (const row of resultOf(response, 'journeys').rows) {
        const signature = row.steps as string[];
        expect(
          signature.filter((step, i) => i > 0 && step === signature[i - 1]),
          `${site.name} ${JSON.stringify(signature)}`,
        ).toEqual([]);
      }
    }
  });

  it('a tight limit keeps the deterministic top of both kinds', () => {
    const envelope = { site: 2, ...FULL_RANGE };
    const response = executeQueryRequest(db, sequenceBatch(envelope, 2, 10));
    const scoped = scopedSessions(envelope);
    expect(resultOf(response, 'sankey').rows).toEqual(expectedTransitions(scoped, 2, 10));
    expect(resultOf(response, 'journeys').rows).toEqual(expectedFlows(scoped, 2, 10));
  });

  it('respects the filter envelope (Mondays only, session-scoped)', () => {
    const envelope = { site: 2, from: '2026-03-01', to: '2026-04-15', weekday: 1 };
    const response = executeQueryRequest(
      db,
      sequenceBatch(envelope, 3, 200, [{ dim: 'weekday', op: 'eq', value: '1' }]),
    );
    const scoped = scopedSessions(envelope);
    expect(scoped.length).toBeGreaterThan(0);
    expect(resultOf(response, 'sankey').rows).toEqual(expectedTransitions(scoped, 3, 200));
    expect(resultOf(response, 'journeys').rows).toEqual(expectedFlows(scoped, 3, 200));
  });

  it('rejects an event-only filter honestly for both kinds', () => {
    const response = executeQueryRequest(
      db,
      sequenceBatch({ site: 2, ...FULL_RANGE }, 4, 20, [
        { dim: 'event_category', op: 'eq', value: 'cta' },
      ]),
    );
    for (const id of ['sankey', 'journeys']) {
      expect(response.results[id]).toHaveProperty(['error', 'code'], 'unsupported');
    }
  });

  it('answers an empty range with empty rows', () => {
    const response = executeQueryRequest(
      db,
      sequenceBatch({ site: 2, from: '2026-01-01', to: '2026-01-31' }, 4, 20),
    );
    expect(resultOf(response, 'sankey').rows).toEqual([]);
    expect(resultOf(response, 'journeys').rows).toEqual([]);
  });

  /**
   * The "under 100 ms" claim used to live here, as a wall-clock assertion. It
   * measured the machine's spare capacity as much as the query: vitest runs test
   * files in parallel workers, so the number moved with whatever else the suite
   * happened to be doing, and it went red the day another file started building
   * a bundle. A guard that fails for a reason unrelated to what it guards is a
   * guard people learn to re-run.
   *
   * It now runs in `bun run bench` as the `journeys @ 90d, busiest site` shape —
   * serial, on the same 90-day on-disk corpus as every other read budget, at the
   * same 100 ms (`bench-thresholds.json`; ratchets tighten, never loosen).
   */
});
