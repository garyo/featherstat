import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actionLabel, placeLabel } from '../lib/realtime.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    // Tests quote markup to assert on it; only renderers count.
    return /\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * The guard behind the rule in CLAUDE.md: one rendering per thing rendered.
 * The realtime feed lived inline in the Realtime view for a month before the
 * dashboard wanted one too, and copying it cost four commits of fixing the
 * same bug twice. If this fails, extract into the shared component rather than
 * teaching a second file the markup.
 */
describe('feed rows have exactly one implementation', () => {
  it('only FeedRows.svelte renders a feed row', () => {
    const owners = sourceFiles(SRC)
      .filter((path) => readFileSync(path, 'utf8').includes('class="feed-row"'))
      .map((path) => path.slice(SRC.length));
    expect(owners).toEqual(['widgets/FeedRows.svelte']);
  });
});

describe('feed row labels', () => {
  const hit = (over: Record<string, unknown> = {}) =>
    ({
      siteId: 1,
      ts: 0,
      type: 'pageview',
      visitor: { name: 'Amiable Aardvark', color: 0 },
      ...over,
    }) as Parameters<typeof placeLabel>[0];

  it('prints city with country, country alone, then Unknown', () => {
    expect(placeLabel(hit({ city: 'Masterton', country: 'NZ' }))).toBe('Masterton, NZ');
    expect(placeLabel(hit({ country: 'NZ' }))).toBe('New Zealand');
    expect(placeLabel(hit())).toBe('Unknown');
  });

  it('prints an event as category · action, and anything else as its path', () => {
    expect(
      actionLabel(hit({ type: 'event', eventCategory: 'signup', eventAction: 'created' })),
    ).toBe('signup · created');
    expect(actionLabel(hit({ type: 'event', eventAction: 'created' }))).toBe('created');
    expect(actionLabel(hit({ path: '/blog' }))).toBe('/blog');
    expect(actionLabel(hit())).toBe('/');
  });
});
