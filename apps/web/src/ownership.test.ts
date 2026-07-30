import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md invariant 7's corollary, as a table: **one rendering per thing
 * rendered**. Each row names a shared rendering, how a file betrays that it
 * draws that thing, and the file(s) allowed to. A new shared rendering is one
 * entry here, not a new test file — which is the point: the two guards this
 * replaces each hard-coded one class and one owner, so the `.bar-row` fork grew
 * next door to the `.feed-row` guard, unwatched, for a month.
 *
 * If one of these fails, extract into the shared component and decorate it —
 * never teach a second file the markup. Every entry below is a bug that shipped
 * twice because it had to be fixed twice.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

interface Rendering {
  /** The thing rendered — the noun in the failure. */
  what: string;
  /** A file owns this rendering when its source contains ALL of these. */
  marks: readonly (string | RegExp)[];
  /** Every file allowed to match, relative to `apps/web/src`. */
  owners: readonly string[];
  /** What a new file should do instead. */
  instead: string;
}

const RENDERINGS: readonly Rendering[] = [
  {
    what: 'a live-feed row',
    marks: ['class="feed-row"'],
    owners: ['widgets/FeedRows.svelte'],
    instead: 'render <FeedRows> and decorate it',
  },
  {
    what: 'a ranked bar row',
    marks: ['class="bar-row"'],
    owners: ['widgets/BarRows.svelte'],
    instead: 'render <BarRows>; a row that needs another number states `text`/`sub`/`tips`',
  },
  {
    what: 'a widget spec as a registry component',
    marks: [/REGISTRY\[[^\]]+\]/, /\.component\b/],
    owners: ['widgets/WidgetGrid.svelte'],
    instead: 'render <WidgetGrid> and pass it a `card` snippet',
  },
  {
    what: "a widget card's frame in the 12-column grammar",
    marks: ['spanClass('],
    owners: ['widgets/WidgetGrid.svelte', 'widgets/registry.ts'],
    instead: 'let <WidgetGrid> hand the frame back through its `card` snippet',
  },
  {
    what: 'the decision that a widget cannot be rendered here',
    marks: ['missingCapability('],
    owners: ['widgets/WidgetGrid.svelte', 'widgets/env.ts'],
    instead: 'declare the capability in `env.ts` NEEDS and let the grid say it once',
  },
  {
    what: 'the sentence a page shows in place of a widget it cannot feed',
    marks: ['CAPABILITY_NOTE'],
    owners: ['widgets/WidgetGrid.svelte', 'widgets/env.ts'],
    instead: 'add a line to CAPABILITY_NOTE rather than a guard inside the widget',
  },
  {
    what: 'the per-visitor tally row',
    marks: ['class="visitor-row"'],
    owners: ['widgets/VisitorTally.svelte'],
    instead: 'render <VisitorTally>, which a page arranges but never re-implements',
  },
];

/** Every renderer under `apps/web/src`. Tests quote markup to assert on it — they don't count. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  name: path.slice(SRC.length),
  source: readFileSync(path, 'utf8'),
}));

function ownersOf(marks: Rendering['marks']): string[] {
  return FILES.filter((file) =>
    marks.every((mark) =>
      typeof mark === 'string' ? file.source.includes(mark) : mark.test(file.source),
    ),
  ).map((file) => file.name);
}

describe('one rendering per thing rendered', () => {
  it('scans the whole tree, so a fork cannot hide in a directory nobody listed', () => {
    // The guard is worth exactly what it reads: if this ever collapses to a
    // handful of files, the walk broke and every assertion below passes vacuously.
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.map((file) => file.name)).toContain('widgets/BarRows.svelte');
  });

  it.each(RENDERINGS)('only $owners renders $what', ({ what, marks, owners, instead }) => {
    expect(
      ownersOf(marks).sort(),
      `${what} is rendered in more than one place — ${instead}`,
    ).toEqual([...owners].sort());
  });
});
