import { describe, expect, it } from 'vitest';
import { webSourceFiles } from './ownership.guard.ts';
import { widgetIoBreaches } from './widget-io.guard.ts';

/**
 * Widgets declare queries; views batch them (CLAUDE.md invariant 1). The scan
 * lives in `widget-io.guard.ts` so `test/guards/meta.test.ts` can hand it a rogue
 * widget and prove it objects.
 */

const widget = (source: string) => [{ name: 'widgets/Rogue.svelte', source }];

describe('widgets reach nothing past env', () => {
  it('holds across every widget source', () => {
    expect(widgetIoBreaches(webSourceFiles())).toEqual([]);
  });

  it.each([
    "const res = await fetch('/api/query');",
    'const res = await window.fetch(url);',
    "import { createQueryClient } from '../lib/api.ts';",
    "import type { QueryClient } from '../lib/api';",
    "import type { AdminClient } from '../lib/admin.ts';",
    "import { createLiveStream } from '../lib/live.ts';",
    "const { createLiveStream } = await import('../lib/live.ts');",
    "const source = new EventSource('/api/live');",
  ])('objects to %s', (source) => {
    const breaches = widgetIoBreaches(widget(source));
    expect(breaches.some((breach) => breach.startsWith('widgets/Rogue.svelte'))).toBe(true);
  });

  it.each([
    "import { scopedHits } from '../lib/realtime.ts';",
    "import { adminObjects } from '../lib/admin-objects.ts';",
    'env.refetch();',
  ])('lets %s through', (source) => {
    expect(widgetIoBreaches(widget(source)).filter((b) => b.includes('Rogue'))).toEqual([]);
  });
});
