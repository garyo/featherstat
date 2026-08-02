import type { QueryRequest } from '@featherstat/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { binId, event, openTestDb, resultOf, session } from '../../test/rows.ts';
import {
  createCampaign,
  type Db,
  deleteCampaign,
  insertEvents,
  upsertSessions,
  withWriteTransaction,
} from '../db/index.ts';
import { executeQueryRequest } from './executor.ts';

/**
 * `campaign_status` (docs/03 § Campaigns): derived per row at query time from
 * the campaigns registry — registered when a registry row covers the row's
 * local date, unregistered when none does, untagged when there is no campaign.
 */

const DAY = '2026-07-27';
const NOW = Date.UTC(2026, 6, 27, 14);

let db: Db;
let registered: number;

function seedVisit(
  sess: number,
  date: string,
  campaign: string | null,
  pages: readonly string[],
): void {
  withWriteTransaction(db, () => {
    insertEvents(
      db,
      pages.map((path, i) =>
        event({
          session_id: binId(sess),
          visitor_id: binId(sess),
          local_date: date,
          ts: Date.parse(`${date}T12:00:00Z`) + i,
          path,
          utm_campaign: campaign,
        }),
      ),
    );
    upsertSessions(db, [
      session({
        id: binId(sess),
        visitor_id: binId(sess),
        local_date: date,
        started_at: Date.parse(`${date}T12:00:00Z`),
        last_seen_at: Date.parse(`${date}T12:00:00Z`),
        pageviews: pages.length,
        utm_campaign: campaign,
      }),
    ]);
  });
}

beforeAll(() => {
  db = openTestDb(2);
  withWriteTransaction(db, () => {
    registered = createCampaign(db, {
      site_id: 1,
      name: 'spring',
      expected_sources: null,
      expected_mediums: null,
      starts_at: '2026-07-01',
      ends_at: '2026-07-31',
      notes: null,
      created_at: NOW,
    }).id;
  });
  seedVisit(1, DAY, 'spring', ['/a', '/b']); // registered: inside the lifespan
  seedVisit(2, DAY, 'rogue', ['/a']); // unregistered: no registry row
  seedVisit(3, DAY, null, ['/a']); // untagged
  seedVisit(4, '2026-06-20', 'spring', ['/a']); // unregistered: before starts_at
});

function ask(query: object, range: QueryRequest['range'] = { from: '2026-06-15', to: DAY }) {
  const request: QueryRequest = {
    site: 1,
    range,
    queries: [{ id: 'q', ...query } as QueryRequest['queries'][number]],
  };
  return executeQueryRequest(db, request, { now: NOW });
}

const resultOfQ = (response: ReturnType<typeof ask>) => resultOf(response, 'q');

describe('campaign_status', () => {
  it('groups pageviews and visits by status, lifespan edges included', () => {
    const { rows, measures } = resultOfQ(
      ask({ metrics: ['pageviews', 'visits'], dim: 'campaign_status' }),
    );
    const byStatus = new Map(rows.map((row) => [row.campaign_status, row]));
    expect(byStatus.get('registered')).toMatchObject({ pageviews: 2, visits: 1 });
    // 'rogue' (1 pv) + the out-of-lifespan 'spring' visit (1 pv)
    expect(byStatus.get('unregistered')).toMatchObject({ pageviews: 2, visits: 2 });
    expect(byStatus.get('untagged')).toMatchObject({ pageviews: 1, visits: 1 });
    expect(measures?.visits?.aggregate).toBeDefined();
  });

  it('answers session metrics grouped by status (sessions side carries the CASE)', () => {
    const { rows } = resultOfQ(ask({ metrics: ['visits'], dim: 'campaign_status' }));
    expect(rows).toHaveLength(3);
    expect(rows.reduce((total, row) => total + Number(row.visits), 0)).toBe(4);
  });

  it("filters with eq 'unregistered'", () => {
    const { rows } = resultOfQ(
      ask({
        metrics: ['pageviews'],
        filters: [{ dim: 'campaign_status', op: 'eq', value: 'unregistered' }],
      }),
    );
    expect(rows[0]?.pageviews).toBe(2);
  });

  it('reflects a registry edit instantly — no backfill, no rewrite', () => {
    withWriteTransaction(db, () => deleteCampaign(db, registered));
    try {
      const { rows } = resultOfQ(ask({ metrics: ['pageviews'], dim: 'campaign_status' }));
      const byStatus = new Map(rows.map((row) => [row.campaign_status, row]));
      expect(byStatus.has('registered')).toBe(false);
      expect(byStatus.get('unregistered')).toMatchObject({ pageviews: 4 });
    } finally {
      withWriteTransaction(db, () => {
        registered = createCampaign(db, {
          site_id: 1,
          name: 'spring',
          expected_sources: null,
          expected_mediums: null,
          starts_at: '2026-07-01',
          ends_at: '2026-07-31',
          notes: null,
          created_at: NOW,
        }).id;
      });
    }
  });

  it('scopes the registry lookup to the row site', () => {
    // Site 2 has the same campaign name in its rows but no registry row.
    seedVisit(9, DAY, 'spring', ['/a']);
    withWriteTransaction(db, () => {
      insertEvents(db, [
        event({
          site_id: 2,
          session_id: binId(20),
          visitor_id: binId(20),
          local_date: DAY,
          path: '/a',
          utm_campaign: 'spring',
        }),
      ]);
    });
    const request: QueryRequest = {
      site: 2,
      range: { from: DAY, to: DAY },
      queries: [{ id: 'q', metrics: ['pageviews'], dim: 'campaign_status' }],
    };
    const { rows } = resultOfQ(executeQueryRequest(db, request, { now: NOW }));
    expect(rows).toEqual([{ campaign_status: 'unregistered', pageviews: 1 }]);
  });
});
