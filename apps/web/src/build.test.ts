import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The docs/05 § "What editability costs" bundle contract, enforced the same way
 * as the tracker budgets (CLAUDE.md invariant 6 — ratchets only tighten):
 *
 * - The entry is the path to a dashboard, and nothing else may ride on it. The
 *   editor (drag-reorder, pickers, export/import), the settings view (sites,
 *   snippet, password, notifications), the share dialog and the public share
 *   page are each their own chunk, loaded when someone actually goes there —
 *   proven below by marker strings that exist only in those components.
 * - The budget: 65 536 B gz held the editor stage's entry (65 315). Moving the
 *   settings view off the entry paid for the share stage and 2 KB besides, so
 *   the ratchet tightens to 63 KiB.
 * - The editor budget is unchanged: its chunk shrank only because `Modal.svelte`
 *   became a shared chunk when the share dialog started using it too.
 */
// Raised 63->64 KiB on 2026-07-28 for the realtime scope selector + site
// badges — deliberate entry-path feature code, not leakage. Editor code must
// still land in its dynamic chunk (asserted below); tighten if it shrinks.
//
// Tightened 64 KiB -> 18 KiB on 2026-07-29 (one widget environment: 17 644 ->
// 16 545 gz). Most of that slack was never this chunk's: rollup now hoists what
// the entry shares with the split chunks into siblings the entry statically
// preloads (`format`, `disclose-version`, `WidgetGrid`), so `index-*.js` alone
// stopped describing the path to a dashboard and the budget quietly stopped
// binding. The four together are 71 117 gz today (70 892 before this change) —
// already past what 64 KiB was meant to cap, and past it before this phase.
// Measuring the whole preloaded set belongs with the other budget work; until
// then this ratchet at least binds again on the chunk it does measure.
const ENTRY_MAX_GZIP = 18_432;
const EDITOR_MAX_GZIP = 6_656;
const SETTINGS_MAX_GZIP = 6_656;
/** The share page and the dialog that mints links for it — small by construction. */
const SHARE_MAX_GZIP = 2_048;

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ASSETS_DIR = `${WEB_ROOT}dist/assets/`;

/** vite is a devDependency of this workspace; bun links its binary here or at the root. */
const VITE_PATHS = ['node_modules/.bin/vite', '../../node_modules/.bin/vite'];

function vitePath(): string {
  for (const candidate of VITE_PATHS) {
    const path = WEB_ROOT + candidate;
    if (existsSync(path)) return path;
  }
  throw new Error(`vite binary not found; looked in ${VITE_PATHS.join(', ')}`);
}

function chunk(prefix: string): Buffer {
  const name = readdirSync(ASSETS_DIR).find(
    (file) => file.startsWith(`${prefix}-`) && file.endsWith('.js'),
  );
  if (name === undefined) throw new Error(`no ${prefix}-*.js chunk in ${ASSETS_DIR}`);
  return readFileSync(ASSETS_DIR + name);
}

beforeAll(() => {
  // Captured rather than inherited: vite's size summary is noise inside the test
  // run. NODE_ENV is pinned — vitest's `test` would otherwise leak in and build
  // a dev-flavored (larger) bundle than `bun run build` ships.
  execFileSync(vitePath(), ['build'], {
    cwd: WEB_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}, 120_000);

describe('web bundles', () => {
  it(`keeps the entry under ${ENTRY_MAX_GZIP} bytes gzipped`, () => {
    const entry = chunk('index');
    expect(entry.length).toBeGreaterThan(0);
    expect(gzipSync(entry).length).toBeLessThan(ENTRY_MAX_GZIP);
  });

  it(`splits the editor into its own chunk under ${EDITOR_MAX_GZIP} bytes gzipped`, () => {
    const editor = chunk('editor');
    expect(editor.length).toBeGreaterThan(0);
    expect(gzipSync(editor).length).toBeLessThan(EDITOR_MAX_GZIP);
  });

  it(`splits settings into its own chunk under ${SETTINGS_MAX_GZIP} bytes gzipped`, () => {
    expect(gzipSync(chunk('SettingsView')).length).toBeLessThan(SETTINGS_MAX_GZIP);
  });

  it(`splits the share page and its dialog, each under ${SHARE_MAX_GZIP} bytes gzipped`, () => {
    // The share page reuses the dashboard grid and the widgets, so its own chunk
    // is the page shell and the one fetch — everything else is already aboard.
    expect(gzipSync(chunk('share')).length).toBeLessThan(SHARE_MAX_GZIP);
    expect(gzipSync(chunk('dialog')).length).toBeLessThan(SHARE_MAX_GZIP);
  });

  it('ships zero editor, settings or share code on the view path', () => {
    const entry = String(chunk('index'));
    // Marker strings that exist only in the split components — any of them in
    // the entry means that split broke.
    const markers: Record<string, string[]> = {
      editor: ['Add widget', 'Apply to draft', 'Drag to reorder', 'Editing'],
      SettingsView: ['Tracking snippet', 'Send test notification'],
      share: ['Shared dashboard'],
      dialog: ['Create share link'],
    };
    for (const [name, strings] of Object.entries(markers)) {
      const own = String(chunk(name));
      for (const marker of strings) {
        expect(entry).not.toContain(marker);
        expect(own).toContain(marker);
      }
    }
  });
});
