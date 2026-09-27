import { describe, expect, it } from 'vitest';
import { epochBreaches, jobSources, withoutComments } from './epoch.guard.ts';

/**
 * CLAUDE.md invariant 10: every history-rewriting job bumps `data_epoch`. The
 * scan and its rationale live in `epoch.guard.ts`; `test/guards/inventory.ts`
 * mutation-tests that the scan still objects to a missing bump.
 */
describe('epoch discipline', () => {
  it('every job that rewrites stored history bumps the data epoch', () => {
    expect(epochBreaches(jobSources())).toEqual([]);
  });

  it('reads code, not comments — and never mistakes a literal for a comment', () => {
    const code = withoutComments(
      "const url = 'https://x.test/*a*/';\n// bumpDataEpoch(db)\n/* DELETE FROM events */\n" +
        'const sql = `SELECT 1 // kept`;',
    );
    expect(code).toContain('https://x.test/*a*/');
    expect(code).toContain('`SELECT 1 // kept`');
    expect(code).not.toContain('bumpDataEpoch');
    expect(code).not.toContain('DELETE FROM events');
  });
});
