import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, ifNoneMatchHits } from './etag.ts';

describe('ifNoneMatchHits', () => {
  const tag = '"abc123"';

  it('misses without a header and on a different tag', () => {
    expect(ifNoneMatchHits(undefined, tag)).toBe(false);
    expect(ifNoneMatchHits('"other"', tag)).toBe(false);
  });

  it('matches the exact tag anywhere in a list', () => {
    expect(ifNoneMatchHits(tag, tag)).toBe(true);
    expect(ifNoneMatchHits(`"x", ${tag} ,"y"`, tag)).toBe(true);
  });

  it('compares weakly, as RFC 9110 requires for If-None-Match', () => {
    expect(ifNoneMatchHits(`W/${tag}`, tag)).toBe(true);
    expect(ifNoneMatchHits(`"x", W/${tag}`, tag)).toBe(true);
    expect(ifNoneMatchHits('W/"other"', tag)).toBe(false);
  });

  it('treats * as matching any current representation', () => {
    expect(ifNoneMatchHits('*', tag)).toBe(true);
  });
});

describe('canonicalize', () => {
  it('ignores key order and undefined members', () => {
    expect(canonicalize({ b: 1, a: [{ d: 2, c: undefined }] })).toBe(
      canonicalize({ a: [{ d: 2 }], b: 1 }),
    );
  });
});

describe('batchEtag', () => {
  afterEach(() => {
    vi.doUnmock('@featherstat/shared');
    vi.resetModules();
  });

  /** The tag under a given bounce threshold — a code constant a deploy can change. */
  async function tagUnder(threshold: number): Promise<string> {
    vi.resetModules();
    vi.doMock('@featherstat/shared', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@featherstat/shared')>()),
      ENGAGEMENT_THRESHOLD_MS: threshold,
    }));
    const { batchEtag } = await import('./etag.ts');
    return batchEtag(7, 104, '{}', [], 0);
  }

  it('moves with the engagement threshold, which changes bounce without moving data', async () => {
    expect(await tagUnder(10_000)).toBe(await tagUnder(10_000));
    expect(await tagUnder(10_000)).not.toBe(await tagUnder(15_000));
  });
});
