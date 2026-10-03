import type { RangePreset } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { type Answered, allSitesAnswer, siteAnswer, useContractDb } from './corpus.ts';
import {
  BATCH_MAX_AXIS_KEYS,
  BATCH_MAX_BYTES,
  bytesOf,
  isRows,
  RESULT_MAX_BYTES,
  responseSizeBreaches,
} from './response-size.guard.ts';

/**
 * The response-size ratchet, asserted against real answers. The budgets and the
 * checks live in `response-size.guard.ts`, so `test/guards/meta.test.ts` can
 * feed those same checks an over-sized answer and prove they object — this file
 * supplies the reality, that one supplies the proof it is being measured.
 */

const PRESETS: readonly RangePreset[] = ['today', '24h', '7d', '30d', '90d'];

useContractDb();

const batches: Array<{ name: string; answered: Answered }> = PRESETS.flatMap((range) => [
  { name: `site dashboard @ ${range}`, answered: siteAnswer(undefined, range) },
  { name: `all-sites dashboard @ ${range}`, answered: allSitesAnswer(range) },
]);

describe('a query response stays inside its budget', () => {
  it.each(batches)(
    `keeps $name under ${BATCH_MAX_BYTES} B, each result under ${RESULT_MAX_BYTES} B, and under ${BATCH_MAX_AXIS_KEYS} axis keys`,
    ({ name, answered }) => {
      expect(responseSizeBreaches(name, answered.response)).toEqual([]);
    },
  );
});

describe('what keeps the budget reachable', () => {
  it('leaves rows sparse: an axis is a key list, never a promise of a row per key', () => {
    // `responseSizeBreaches` asserts rows <= axis keys for every result above.
    // What it cannot assert is that the bound is not an identity — so here:
    // somewhere in the sweep, a result really is sparser than its axis.
    let checked = 0;
    let sparse = false;
    for (const { answered } of batches) {
      for (const entry of Object.values(answered.response.results)) {
        if (!isRows(entry) || entry.axis === undefined) continue;
        checked += 1;
        const keys = entry.axis.reduce((sum, axis) => sum + axis.keys.length, 0);
        if (entry.rows.length < keys) sparse = true;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(sparse, 'every bucket is full — the sparse bound proves nothing').toBe(true);
  });

  it('is measured against answers with real bulk in them', () => {
    // A budget met by empty responses is not met. The biggest batch in the sweep
    // has to be a meaningful fraction of what it is allowed to be, or the numbers
    // above are bounding nothing.
    const largest = Math.max(...batches.map(({ answered }) => bytesOf(answered.response)));
    expect(largest).toBeGreaterThan(BATCH_MAX_BYTES / 4);
  });
});
