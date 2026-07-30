import { MAX_AXIS_KEYS, type QueryResult, type RangePreset } from '@featherstat/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { type Answered, allSitesAnswer, closeContractDb, siteAnswer } from './corpus.ts';

/**
 * How big an answer is allowed to get — a ratchet in the same family as the
 * replay perf budget and the first-load bundle budget (CLAUDE.md invariant 6:
 * these tighten, never loosen).
 *
 * Nothing bounded a `/api/query` response before this. P1 caps ONE result's axis
 * at `MAX_AXIS_KEYS`, and `MetricQuerySchema` caps one query's `limit` at 1000 —
 * but a batch carries up to `MAX_QUERIES_PER_BATCH` of them, `site: 'all'` fans
 * each across every site, and the all-sites cards deliberately run an
 * UNLIMITED `path × day` query per site (`sitePagesQueries`: a LIMIT there would
 * truncate whole days rather than whole pages). That product is a stored,
 * client-authored query plan, executed server-side, reachable through a public
 * share link — so its output deserves a number, and the number deserves a test.
 *
 * Measured on the real thing: the bytes `c.json()` will serialize, for the
 * dashboards the app actually ships, at every preset a reader can pick. The
 * budgets bound THIS corpus, exactly as the bench's bytes-per-event and the
 * bundle ratchet bound their own fixed inputs; what they catch is a change that
 * makes an answer cost multiples of what it costs today.
 *
 * Today's worst case is the all-sites batch at 90 d: 93 122 B across 1 138 rows
 * and 540 axis keys, and its largest single result is one site's page trend at
 * 22 805 B. The budgets sit ~1.4× above each, which is room for ordinary work
 * and not room for a dense fill.
 */

/** One `/api/query` body, whole. */
const BATCH_MAX_BYTES = 131_072;
/** One result inside it — so a runaway breakdown is named, not averaged away. */
const RESULT_MAX_BYTES = 32_768;
/**
 * Axis keys summed across a batch. `MAX_AXIS_KEYS` bounds one result for one
 * site; this bounds their product, which is what actually rides the wire.
 */
const BATCH_MAX_AXIS_KEYS = 1_024;

const PRESETS: readonly RangePreset[] = ['today', '7d', '30d', '90d'];

afterAll(closeContractDb);

const batches: Array<{ name: string; answered: Answered }> = PRESETS.flatMap((range) => [
  { name: `site dashboard @ ${range}`, answered: siteAnswer(undefined, range) },
  { name: `all-sites dashboard @ ${range}`, answered: allSitesAnswer(range) },
]);

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

const isRows = (entry: QueryResult | { error: unknown }): entry is QueryResult =>
  !('error' in entry);

/** Per-result sizes, biggest first — the failure says WHICH result grew. */
function breakdown(answered: Answered): string {
  return Object.entries(answered.response.results)
    .map(([id, entry]) => [id, bytes(entry)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, size]) => `${id} ${size}`)
    .join(', ');
}

function axisKeys(answered: Answered): number {
  return Object.values(answered.response.results).reduce((total, entry) => {
    if (!isRows(entry) || entry.axis === undefined) return total;
    return total + entry.axis.reduce((sum, axis) => sum + axis.keys.length, 0);
  }, 0);
}

describe('a query response stays inside its budget', () => {
  it.each(batches)(`keeps $name under ${BATCH_MAX_BYTES} bytes`, ({ answered }) => {
    expect(bytes(answered.response), `largest results: ${breakdown(answered)}`).toBeLessThan(
      BATCH_MAX_BYTES,
    );
  });

  it.each(batches)(
    `keeps every result of $name under ${RESULT_MAX_BYTES} bytes`,
    ({ answered }) => {
      for (const [id, entry] of Object.entries(answered.response.results)) {
        expect(bytes(entry), `result '${id}'`).toBeLessThan(RESULT_MAX_BYTES);
      }
    },
  );

  it.each(batches)(
    `enumerates at most ${BATCH_MAX_AXIS_KEYS} axis keys for $name`,
    ({ answered }) => {
      expect(axisKeys(answered)).toBeLessThan(BATCH_MAX_AXIS_KEYS);
    },
  );
});

describe('what keeps the budget reachable', () => {
  it('leaves rows sparse: an axis is a key list, never a promise of a row per key', () => {
    // The mechanism the numbers above rest on (P1). Dense zero-filling was the
    // original sketch and would make a 2-D result the product of its two
    // dimensions — tens of thousands of manufactured rows, down a code path a
    // client-authored layout reaches through a public share link.
    let checked = 0;
    for (const { name, answered } of batches) {
      for (const [id, entry] of Object.entries(answered.response.results)) {
        if (!isRows(entry) || entry.axis === undefined) continue;
        const keys = entry.axis.reduce((sum, axis) => sum + axis.keys.length, 0);
        expect(entry.rows.length, `${name} '${id}'`).toBeLessThanOrEqual(keys);
        checked += 1;
      }
    }
    // Slack: at least one result really is sparser than its axis, so the bound
    // is not passing because every bucket happens to be full.
    expect(checked).toBeGreaterThan(0);
    expect(
      batches.some(({ answered }) =>
        Object.values(answered.response.results).some(
          (entry) =>
            isRows(entry) &&
            entry.axis !== undefined &&
            entry.rows.length < entry.axis.reduce((sum, axis) => sum + axis.keys.length, 0),
        ),
      ),
    ).toBe(true);
  });

  it('withholds the axis entirely rather than enumerating past its own cap', () => {
    // An explicit hourly range can outrun `MAX_AXIS_KEYS`; past it the rows'
    // own order is the axis and the response does not carry the enumeration.
    for (const { name, answered } of batches) {
      for (const [id, entry] of Object.entries(answered.response.results)) {
        if (!isRows(entry) || entry.axis === undefined) continue;
        for (const axis of entry.axis) {
          expect(axis.keys.length, `${name} '${id}' site ${axis.siteId}`).toBeLessThanOrEqual(
            MAX_AXIS_KEYS,
          );
        }
      }
    }
  });
});
