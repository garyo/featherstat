import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('walks subdirectories of the jobs tree, and skips tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'featherstat-jobs-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'top.ts'), '');
      writeFileSync(join(dir, 'nested', 'deep.ts'), '');
      writeFileSync(join(dir, 'nested', 'deep.test.ts'), '');
      expect(jobSources(dir).map((file) => file.name)).toEqual(['nested/deep.ts', 'top.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
