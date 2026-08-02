import { DimensionSchema } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.ts';
import { eventOnlyDimension, sessionOnlyDimension } from '../query/compiler.ts';
import { EVENT_ROLLUP_DIMS, NO_DIM_ID, ROLLUP_DIMS, SESSION_ROLLUP_DIMS } from './tables.ts';

describe('ROLLUP_DIMS', () => {
  it('assigns every dimension in the vocabulary — exhaustiveness is the point', () => {
    for (const dim of DimensionSchema.options) {
      expect(ROLLUP_DIMS[dim], dim).toBeDefined();
    }
  });

  it('dim ids are unique and never the reserved undimensioned id', () => {
    const ids = Object.values(ROLLUP_DIMS)
      .filter((entry) => typeof entry !== 'string')
      .map((entry) => entry.dimId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(NO_DIM_ID);
  });

  /**
   * Frozen forever: these ids key rollup rows that outlive raw events, so a
   * renumbering silently merges two dimensions' history. Editing this table is
   * only legal for APPENDED dimensions.
   */
  it('the id assignment is the frozen one', () => {
    const assigned = Object.fromEntries(
      Object.entries(ROLLUP_DIMS).flatMap(([dim, entry]) =>
        typeof entry === 'string' ? [] : [[dim, entry.dimId]],
      ),
    );
    expect(assigned).toEqual({
      path: 1,
      hostname: 2,
      ref_domain: 3,
      ref_type: 4,
      utm_source: 5,
      utm_medium: 6,
      utm_campaign: 7,
      country: 8,
      region: 9,
      city: 10,
      browser: 11,
      os: 12,
      device_type: 13,
      screen: 14,
      lang: 15,
      event_category: 16,
      event_action: 17,
      event_name: 18,
      target_url: 19,
      entry_path: 20,
      exit_path: 21,
    });
  });

  it('each rolled dim rolls on exactly the sides whose table carries it (compiler DIMS)', () => {
    for (const [dim, entry] of Object.entries(ROLLUP_DIMS)) {
      if (typeof entry === 'string') continue;
      const d = DimensionSchema.parse(dim);
      const expected = sessionOnlyDimension(d)
        ? 'sessions'
        : eventOnlyDimension(d)
          ? 'events'
          : 'both';
      expect(entry.tables, dim).toBe(expected);
    }
  });

  it('every rolled column is a real column of the table its side reads', () => {
    const db = openDb(':memory:');
    try {
      const columns = (table: string): Set<string> =>
        new Set(
          (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name),
        );
      const events = columns('events');
      const sessions = columns('sessions');
      for (const { column } of EVENT_ROLLUP_DIMS) expect(events, column).toContain(column);
      for (const { column } of SESSION_ROLLUP_DIMS) expect(sessions, column).toContain(column);
    } finally {
      db.close();
    }
  });
});
