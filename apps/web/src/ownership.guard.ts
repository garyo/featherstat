import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLAUDE.md invariant 7's corollary, as a table: **one rendering per thing
 * rendered**.
 *
 * @guard markup-ownership
 *
 * Each row names a shared rendering, how a file betrays that it draws that thing,
 * and the file(s) allowed to. A new shared rendering is one entry here, not a new
 * test file — which is the point: the two guards this replaces each hard-coded
 * one class and one owner, so the `.bar-row` fork grew next door to the
 * `.feed-row` guard, unwatched, for a month.
 *
 * If one of these fails, extract into the shared component and decorate it —
 * never teach a second file the markup. Every entry below is a bug that shipped
 * twice because it had to be fixed twice.
 *
 * The scan takes its files as an argument so `test/guards/meta.test.ts` can hand
 * it an invented fork and check that this actually objects.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

export interface Rendering {
  /** The thing rendered — the noun in the failure. */
  what: string;
  /** A file owns this rendering when its source contains ALL of these. */
  marks: readonly (string | RegExp)[];
  /** Every file allowed to match, relative to `apps/web/src`. */
  owners: readonly string[];
  /** What a new file should do instead. */
  instead: string;
}

export const RENDERINGS: readonly Rendering[] = [
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

/** The guard is worth exactly what it reads; below this the walk broke. */
export const MIN_SOURCE_FILES = 50;

export interface SourceFile {
  /** Path relative to `apps/web/src`. */
  name: string;
  source: string;
}

/**
 * Every renderer under `apps/web/src`. Tests quote markup to assert on it and
 * `*.guard.ts` files declare it to look for it — neither draws anything, so
 * neither counts.
 */
export function webSourceFiles(dir: string = SRC, base: string = SRC): SourceFile[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return webSourceFiles(path, base);
    if (!/\.(svelte|ts)$/.test(name) || /\.(test|guard)\.ts$/.test(name)) return [];
    return [{ name: path.slice(base.length), source: readFileSync(path, 'utf8') }];
  });
}

export function ownersOf(files: readonly SourceFile[], marks: Rendering['marks']): string[] {
  return files
    .filter((file) =>
      marks.every((mark) =>
        typeof mark === 'string' ? file.source.includes(mark) : mark.test(file.source),
      ),
    )
    .map((file) => file.name)
    .sort();
}

/** Every rendering drawn somewhere other than the file that owns it. */
export function ownershipBreaches(files: readonly SourceFile[]): string[] {
  const breaches: string[] = [];
  if (files.length < MIN_SOURCE_FILES) {
    breaches.push(`only ${files.length} source files scanned — the walk broke`);
  }
  for (const rendering of RENDERINGS) {
    const found = ownersOf(files, rendering.marks);
    const expected = [...rendering.owners].sort();
    if (found.join('|') !== expected.join('|')) {
      breaches.push(
        `${rendering.what} is rendered by [${found.join(', ')}], expected [${expected.join(', ')}] — ${rendering.instead}`,
      );
    }
  }
  return breaches;
}
