import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUNDLES, buildBundle, bundleBreaches, DIST_DIR } from './build.ts';

const built = new Map<string, Buffer>();

beforeAll(() => {
  for (const bundle of BUNDLES) built.set(bundle.file, readFileSync(buildBundle(bundle)));
}, 30_000);

describe('tracker bundles', () => {
  /**
   * The budgets from docs/04 are a ratchet (CLAUDE.md invariant 6): a failure
   * here means the bundle grew, not that the number was too small.
   */
  for (const bundle of BUNDLES) {
    it(`${bundle.file} stays under ${bundle.maxGzipBytes} bytes gzipped`, () => {
      const output = built.get(bundle.file);
      expect(output?.length).toBeGreaterThan(0);
      expect(gzipSync(output ?? Buffer.alloc(0)).length).toBeLessThan(bundle.maxGzipBytes);
    });
  }

  it('ships the shim self-executing and the native tracker as ESM', () => {
    expect(String(built.get('matomo.js'))).not.toMatch(/\bexport\b/);
    expect(String(built.get('tracker.js'))).toMatch(/export\{[^}]*init/);
  });

  it('agrees with the reusable check `test/guards` mutates', () => {
    // Same facts, one function, so proving that function binds proves this does.
    expect(bundleBreaches(DIST_DIR)).toEqual([]);
  });
});
