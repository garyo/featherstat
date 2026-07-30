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
/**
 * The budget is the WHOLE first-load module graph, not one chunk of it.
 *
 * It used to read `index-*.js` alone. Rollup hoists what the entry shares with
 * the split chunks into siblings the entry statically preloads, so that file
 * stopped describing what a browser downloads before first paint and the
 * ratchet quietly stopped binding — it was watching 16 KB while the browser
 * fetched 71 KB across four chunks, over the 64 KiB it meant to cap and over it
 * before anyone noticed. A guard that stops guarding is worse than one that
 * fails. This measures every script the entry HTML pulls in, so the number
 * cannot drift away from the thing it names again.
 *
 * 80 KiB against ~71 KB today: real headroom for ordinary work, tight enough
 * that an accidental import still trips it. Raised from 64 KiB deliberately on
 * 2026-07-30 (Gary: "64k is still a tiny bundle... even the GCE machine we're
 * targeting has decent network IO") — the split-chunk budgets below are what
 * keep the editor, settings and share page off this path.
 */
const FIRST_LOAD_MAX_GZIP = 81_920;
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

/**
 * Every script the entry HTML fetches before first paint: the module itself
 * plus each `modulepreload` sibling rollup hoisted out of it.
 */
function firstLoadScripts(): { name: string; gzip: number }[] {
  const html = readFileSync(`${WEB_ROOT}dist/index.html`, 'utf8');
  const paths = new Set(
    [...html.matchAll(/(?:src|href)="\/([^"]+\.js)"/g)].map((match) => match[1] as string),
  );
  if (paths.size === 0) throw new Error('no scripts referenced by dist/index.html');
  return [...paths].map((path) => ({
    name: path,
    gzip: gzipSync(readFileSync(`${WEB_ROOT}dist/${path}`)).length,
  }));
}

describe('web bundles', () => {
  it(`keeps the whole first load under ${FIRST_LOAD_MAX_GZIP} bytes gzipped`, () => {
    const scripts = firstLoadScripts();
    const total = scripts.reduce((sum, script) => sum + script.gzip, 0);
    // Named in the failure, so a regression says WHICH chunk grew.
    const breakdown = scripts
      .sort((a, b) => b.gzip - a.gzip)
      .map((script) => `${script.name} ${script.gzip}`)
      .join(', ');
    expect(total, `first-load JS: ${breakdown}`).toBeLessThan(FIRST_LOAD_MAX_GZIP);
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
