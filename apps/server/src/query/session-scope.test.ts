import type { FilterNode, SiteWindow } from '@featherstat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binId, openTestDb, session } from '../../test/rows.ts';
import { type Db, upsertSessions, withWriteTransaction } from '../db/index.ts';
import { boundsParams, type CompileError } from './compiler.ts';
import { type SessionScope, sessionScope } from './session-scope.ts';

/**
 * The session envelope the sequence and dwell kinds share: which sessions a
 * batch scope picks, and which filters it refuses to pretend it can apply.
 */

const DAY = '2026-07-27';
const WINDOWS: SiteWindow[] = [{ siteId: 1, timezone: 'America/New_York', from: DAY, to: DAY }];

let db: Db;

beforeAll(() => {
  db = openTestDb(2);
  withWriteTransaction(db, () => {
    upsertSessions(db, [
      session({ id: binId(1), site_id: 1, local_date: DAY, country: 'US' }),
      session({ id: binId(2), site_id: 1, local_date: DAY, country: 'DE' }),
      session({ id: binId(3), site_id: 1, local_date: '2026-07-26', country: 'US' }),
      session({ id: binId(4), site_id: 2, local_date: DAY, country: 'US' }),
    ]);
  });
});

afterAll(() => {
  db.close();
});

function scoped(filters: readonly FilterNode[]): number[] {
  const scope = sessionScope('journeys', filters, WINDOWS) as SessionScope;
  return db
    .prepare<unknown[], Uint8Array>(`${scope.sql}\nSELECT sid FROM scoped ORDER BY sid`)
    .pluck()
    .all(...boundsParams(WINDOWS), ...scope.params)
    .map((sid) => sid[0] as number);
}

function refusal(result: SessionScope | CompileError): string | undefined {
  return 'error' in result ? result.error.message : undefined;
}

describe('sessionScope', () => {
  it("picks the window's sessions on its site and dates, and nothing else", () => {
    expect(scoped([])).toEqual([1, 2]);
  });

  it('narrows by a filter the sessions table answers, binding its value', () => {
    const scope = sessionScope('journeys', [{ dim: 'country', op: 'eq', value: 'DE' }], WINDOWS);
    expect(refusal(scope)).toBeUndefined();
    expect((scope as SessionScope).sql).not.toContain("'DE'");
    expect((scope as SessionScope).params).toEqual(['DE']);
    expect(scoped([{ dim: 'country', op: 'eq', value: 'DE' }])).toEqual([2]);
  });

  it('selects the extra columns a kind asks for', () => {
    const scope = sessionScope('dwell', [], WINDOWS, ['s.engaged_ms AS engaged_ms']);
    expect((scope as SessionScope).sql).toContain('SELECT s.id AS sid, s.engaged_ms AS engaged_ms');
  });

  it('refuses a hit-scoped filter only events can answer, naming the asking kind', () => {
    const scope = sessionScope('journeys', [{ dim: 'path', op: 'eq', value: '/a' }], WINDOWS);
    expect(refusal(scope)).toBe(
      "journeys are session-scoped and cannot honestly apply the event-level filter 'path'",
    );
  });

  it("accepts the same filter scoped to the session's own events", () => {
    const filter: FilterNode = { dim: 'path', op: 'eq', value: '/a', scope: 'session' };
    expect(refusal(sessionScope('journeys', [filter], WINDOWS))).toBeUndefined();
  });

  it('refuses a single-value op handed a list', () => {
    const scope = sessionScope('journeys', [{ dim: 'country', op: 'eq', value: ['US'] }], WINDOWS);
    expect(refusal(scope)).toMatch(/expects a single value/);
  });
});
