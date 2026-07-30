import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildWeb,
  CHUNK_MARKERS,
  CHUNK_MAX_GZIP,
  chunkOf,
  ENTRY_PREFIX,
  FIRST_LOAD_MAX_GZIP,
  firstLoadBreakdown,
  firstLoadGzip,
  WEB_ROOT,
} from './build.guard.ts';

/**
 * The bundle contract, asserted. The budgets and every measurement they rest on
 * live in `build.guard.ts`, parameterized by the dist directory, so
 * `test/guards/meta.test.ts` can build a copy, violate it, and prove this test
 * would have said so — see that file for why a passing budget is not evidence.
 */

const DIST = `${WEB_ROOT}dist`;

beforeAll(() => {
  buildWeb(DIST);
}, 120_000);

describe('web bundles', () => {
  it('builds something to measure', () => {
    expect(existsSync(`${DIST}/index.html`)).toBe(true);
  });

  it(`keeps the whole first load under ${FIRST_LOAD_MAX_GZIP} bytes gzipped`, () => {
    // Named in the failure, so a regression says WHICH chunk grew.
    expect(firstLoadGzip(DIST), `first-load JS: ${firstLoadBreakdown(DIST)}`).toBeLessThan(
      FIRST_LOAD_MAX_GZIP,
    );
  });

  it.each(Object.entries(CHUNK_MAX_GZIP))(
    'splits %s into its own chunk under %d bytes gzipped',
    (prefix, limit) => {
      const chunk = chunkOf(DIST, prefix);
      expect(chunk.length).toBeGreaterThan(0);
      expect(gzipSync(chunk).length).toBeLessThan(limit);
    },
  );

  it('ships zero editor, settings or share code on the view path', () => {
    const entry = String(chunkOf(DIST, ENTRY_PREFIX));
    for (const [prefix, markers] of Object.entries(CHUNK_MARKERS)) {
      const own = String(chunkOf(DIST, prefix));
      for (const marker of markers) {
        expect(entry).not.toContain(marker);
        expect(own).toContain(marker);
      }
    }
  });
});
