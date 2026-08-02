import { describe, expect, it } from 'vitest';
import { epochBreaches, jobSources } from './epoch.guard.ts';

/**
 * CLAUDE.md invariant 10: every history-rewriting job bumps `data_epoch`. The
 * scan and its rationale live in `epoch.guard.ts`; `test/guards/inventory.ts`
 * mutation-tests that the scan still objects to a missing bump.
 */
describe('epoch discipline', () => {
  it('every job that rewrites stored history bumps the data epoch', () => {
    expect(epochBreaches(jobSources())).toEqual([]);
  });
});
