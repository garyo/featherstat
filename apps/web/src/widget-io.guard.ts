import type { SourceFile } from './ownership.guard.ts';

/**
 * CLAUDE.md invariant 1's unguarded half, as a scan: **widgets declare queries;
 * views batch them**.
 *
 * @guard widget-io
 *
 * A widget reads `env` and nothing else — the batch's results arrive in
 * `env.data`, the live stream's state in `env.realtime`. One that fetches for
 * itself, holds a query or admin client, or opens its own stream is the per-widget
 * request pattern this project exists to replace, so each of those is a breach
 * wherever under `widgets/` it appears.
 *
 * The scan takes its files as an argument so `test/guards/meta.test.ts` can hand
 * it an invented rogue widget and check that this actually objects.
 */

interface WidgetIo {
  /** What the widget did — the noun in the failure. */
  what: string;
  pattern: RegExp;
}

/** A module under `lib/` that talks to the server, imported by path (type-only included). */
function importOf(module: string): RegExp {
  return new RegExp(`(?:from|import)\\s*\\(?\\s*['"][^'"]*/lib/${module}(?:\\.ts)?['"]`);
}

const WIDGET_IO: readonly WidgetIo[] = [
  { what: 'calls fetch', pattern: /(?<![\w$])fetch\s*\(/ },
  {
    what: 'opens a stream or socket',
    pattern: /\bnew\s+(?:EventSource|WebSocket|XMLHttpRequest)\b/,
  },
  { what: 'sends a beacon', pattern: /\bsendBeacon\s*\(/ },
  { what: 'imports the query client (lib/api)', pattern: importOf('api') },
  { what: 'imports the admin client (lib/admin)', pattern: importOf('admin') },
  { what: 'imports the live stream (lib/live)', pattern: importOf('live') },
];

/** The guard is worth exactly what it reads; below this the walk broke. */
const MIN_WIDGET_FILES = 20;

/** Every file under `widgets/` that reaches past its `env` to the network. */
export function widgetIoBreaches(files: readonly SourceFile[]): string[] {
  const widgets = files.filter((file) => file.name.startsWith('widgets/'));
  const breaches: string[] = [];
  if (widgets.length < MIN_WIDGET_FILES) {
    breaches.push(`only ${widgets.length} widget sources scanned — the walk broke`);
  }
  for (const file of widgets) {
    for (const { what, pattern } of WIDGET_IO) {
      if (pattern.test(file.source)) {
        breaches.push(
          `${file.name} ${what} — a widget declares its queries and reads env; the view batches`,
        );
      }
    }
  }
  return breaches;
}
