import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    // Tests quote the markup they assert on; only renderers count.
    return /\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

function ownersOf(matches: (source: string) => boolean): string[] {
  return sourceFiles(SRC)
    .filter((path) => matches(readFileSync(path, 'utf8')))
    .map((path) => path.slice(SRC.length));
}

/**
 * The guard behind CLAUDE.md invariant 7's corollary — one rendering per thing
 * rendered. The view grid and the editor's grid each owned a copy of this loop:
 * the editor's preview silently lost capabilities the view path passed, and
 * every prop added afterwards had to be added twice. If this fails, decorate
 * `WidgetGrid` (pass it a `card` snippet) rather than teaching a second file
 * how to instantiate a widget.
 */
describe('widget rendering has exactly one implementation', () => {
  it('only WidgetGrid.svelte turns a spec into a registry component', () => {
    const owners = ownersOf(
      (source) => /REGISTRY\[[^\]]+\]/.test(source) && /\.component\b/.test(source),
    );
    expect(owners).toEqual(['widgets/WidgetGrid.svelte']);
  });

  it('only WidgetGrid.svelte decides a widget card frame', () => {
    expect(ownersOf((source) => source.includes('spanClass('))).toEqual([
      'widgets/WidgetGrid.svelte',
      'widgets/registry.ts',
    ]);
  });
});
