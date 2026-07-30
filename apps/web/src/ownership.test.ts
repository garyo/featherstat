import { describe, expect, it } from 'vitest';
import { MIN_SOURCE_FILES, ownersOf, RENDERINGS, webSourceFiles } from './ownership.guard.ts';

/**
 * One rendering per thing rendered (CLAUDE.md invariant 7). The table and the
 * scan live in `ownership.guard.ts` so `test/guards/meta.test.ts` can hand this
 * same scan an invented fork and prove it objects.
 */

const FILES = webSourceFiles();

describe('one rendering per thing rendered', () => {
  it('scans the whole tree, so a fork cannot hide in a directory nobody listed', () => {
    // The guard is worth exactly what it reads: if this ever collapses to a
    // handful of files, the walk broke and every assertion below passes vacuously.
    expect(FILES.length).toBeGreaterThan(MIN_SOURCE_FILES);
    expect(FILES.map((file) => file.name)).toContain('widgets/BarRows.svelte');
  });

  it.each(RENDERINGS)('only $owners renders $what', ({ what, marks, owners, instead }) => {
    expect(
      ownersOf(FILES, marks),
      `${what} is rendered in more than one place — ${instead}`,
    ).toEqual([...owners].sort());
  });
});
