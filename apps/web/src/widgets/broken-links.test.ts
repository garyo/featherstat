import { describe, expect, it } from 'vitest';
import { brokenLinkBars } from './broken-links.ts';

const row = (overrides: Record<string, string | number | null>) => ({
  path: '/old-post',
  hits: 4,
  referred: 3,
  ref_domain: 'blog.test',
  ref_path: '/links',
  last_seen: '2026-10-02',
  ...overrides,
});

describe('brokenLinkBars', () => {
  it('names the path, its hits, and the page linking to it', () => {
    const [bar] = brokenLinkBars([row({})]);

    expect(bar).toMatchObject({
      name: '/old-post',
      value: 4,
      pct: '100.0',
      filterValue: undefined,
      sub: 'from blog.test/links · last Oct 2',
    });
    expect(bar?.tips).toEqual([
      { value: '4', label: 'hits' },
      { value: '3', label: 'with a referrer' },
      { value: 'blog.test/links', label: 'most often from' },
    ]);
  });

  it('says so when nothing links there, and when the page never said what was asked for', () => {
    const [, bar] = brokenLinkBars([
      row({}),
      row({ path: null, hits: 2, referred: 0, ref_domain: null, ref_path: null }),
    ]);

    expect(bar).toMatchObject({
      name: '(path not reported)',
      pct: '50.0',
      sub: 'no referrer · last Oct 2',
    });
    expect(bar?.tips).toHaveLength(2);
  });
});
