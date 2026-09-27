import { HitTypeSchema, POPULATIONS, type Population } from '@featherstat/shared';
import BetterSqlite3 from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { populationSql, populationWhere } from './population.ts';

/**
 * The one place a population becomes SQL (docs/03 § Populations). Beyond the
 * literal text, every hit-row population is run against one row per hit type,
 * so a predicate that reads right but selects wrong still fails.
 */

const ALL = Object.keys(POPULATIONS) as Population[];

/** Selected by a window function over a session's rows, never by a row test. */
const WINDOWED = ALL.filter(
  (name) => POPULATIONS[name].rows === 'hits' && POPULATIONS[name].measured,
);

const db = new BetterSqlite3(':memory:');
db.exec('CREATE TABLE e (type TEXT NOT NULL)');
const insert = db.prepare('INSERT INTO e (type) VALUES (?)');
for (const type of HitTypeSchema.options) insert.run(type);

afterAll(() => {
  db.close();
});

function selected(population: Population): string[] {
  return db
    .prepare<[], string>(
      `SELECT type FROM e WHERE ${populationWhere(population, 'e')} ORDER BY type`,
    )
    .pluck()
    .all();
}

describe('populationSql', () => {
  it('writes the shorter side of a hit-type split', () => {
    expect(populationSql('actions', 'e')).toBe("e.type != 'ping'");
    expect(populationSql('pageviews', 'x')).toBe("x.type = 'pageview'");
  });

  it('has nothing to test where every row of the table qualifies', () => {
    expect(populationSql('presence', 'e')).toBeNull();
    expect(populationSql('sessions', 's')).toBeNull();
    expect(populationWhere('presence', 'e')).toBe('1');
  });

  it('measures a visit by time on the clock', () => {
    expect(populationSql('measured_sessions', 's')).toBe('s.engaged_ms > 0');
  });

  it('refuses a population no row can be tested against', () => {
    expect(WINDOWED).toContain('measured_pageviews');
    for (const name of WINDOWED) {
      expect(() => populationSql(name, 'e'), name).toThrow(/is not a row predicate/);
    }
  });

  it.each(ALL.filter((name) => POPULATIONS[name].rows === 'hits' && !POPULATIONS[name].measured))(
    '%s selects exactly its declared hit types',
    (name) => {
      const declared = POPULATIONS[name].hitTypes ?? HitTypeSchema.options;
      expect(selected(name)).toEqual([...declared].sort());
    },
  );
});
