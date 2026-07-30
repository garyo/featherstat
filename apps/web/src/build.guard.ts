import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * What the SPA is allowed to weigh, and how that is measured.
 *
 * @guard web-bundles
 *
 * The docs/05 § "What editability costs" bundle contract (CLAUDE.md invariant 6
 * — ratchets only tighten):
 *
 * - The entry is the path to a dashboard, and nothing else may ride on it. The
 *   editor (drag-reorder, pickers, export/import), the settings view (sites,
 *   snippet, password, notifications), the share dialog and the public share
 *   page are each their own chunk, loaded when someone actually goes there —
 *   proven by marker strings that exist only in those components.
 * - The first-load budget is the WHOLE first-load module graph, not one chunk of
 *   it. It used to read `index-*.js` alone; rollup hoists what the entry shares
 *   with the split chunks into siblings the entry statically preloads, so that
 *   file stopped describing what a browser downloads before first paint and the
 *   ratchet quietly stopped binding — 16 KB watched while 71 KB was fetched,
 *   over the 64 KiB it meant to cap, for a month. That is why every function
 *   here takes the dist directory as an argument: `test/guards/` builds a copy,
 *   pads a chunk that is NOT the entry, and fails the build if this does not
 *   notice. A guard that has never been seen to fail is not known to work.
 *
 * 80 KiB against ~71 KB today: real headroom for ordinary work, tight enough
 * that an accidental import still trips it. Raised from 64 KiB deliberately on
 * 2026-07-30 (Gary: "64k is still a tiny bundle... even the GCE machine we're
 * targeting has decent network IO") — the split-chunk budgets are what keep the
 * editor, settings and share page off this path.
 */

export const FIRST_LOAD_MAX_GZIP = 81_920;

export const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** vite is a devDependency of this workspace; bun links its binary here or at the root. */
const VITE_PATHS = ['node_modules/.bin/vite', '../../node_modules/.bin/vite'];

/**
 * A production build into `outDir`. Both callers go through this so the thing
 * measured and the thing mutated are the same artifact, and so the meta-guard can
 * build into a temp directory instead of racing this workspace's `dist/`.
 */
export function buildWeb(outDir: string): void {
  // Captured rather than inherited: vite's size summary is noise inside the test
  // run. NODE_ENV is pinned — vitest's `test` would otherwise leak in and build
  // a dev-flavored (larger) bundle than `bun run build` ships.
  execFileSync(vitePath(), ['build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: WEB_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

function vitePath(): string {
  for (const candidate of VITE_PATHS) {
    const path = WEB_ROOT + candidate;
    if (existsSync(path)) return path;
  }
  throw new Error(`vite binary not found; looked in ${VITE_PATHS.join(', ')}`);
}

/** Chunk name prefix → gzipped ceiling. Every one must exist in the build. */
export const CHUNK_MAX_GZIP: Readonly<Record<string, number>> = {
  editor: 6_656,
  SettingsView: 6_656,
  /** The share page and the dialog that mints links for it — small by construction. */
  share: 2_048,
  dialog: 2_048,
};

/**
 * Strings that exist only inside a split component. Finding one in the entry
 * means that split broke and the code ships to every reader.
 */
export const CHUNK_MARKERS: Readonly<Record<string, readonly string[]>> = {
  editor: ['Add widget', 'Apply to draft', 'Drag to reorder', 'Editing'],
  SettingsView: ['Tracking snippet', 'Send test notification'],
  share: ['Shared dashboard'],
  dialog: ['Create share link'],
};

/** The entry chunk's own prefix — what the old, broken version of this guard measured alone. */
export const ENTRY_PREFIX = 'index';

interface Script {
  name: string;
  gzip: number;
}

/** The hashed file a chunk prefix resolves to, absolute. */
export function chunkFileOf(dist: string, prefix: string): string {
  const name = readdirSync(`${dist}/assets`).find(
    (file) => file.startsWith(`${prefix}-`) && file.endsWith('.js'),
  );
  if (name === undefined) throw new Error(`no ${prefix}-*.js chunk in ${dist}/assets`);
  return `${dist}/assets/${name}`;
}

export function chunkOf(dist: string, prefix: string): Buffer {
  return readFileSync(chunkFileOf(dist, prefix));
}

/**
 * Every script the entry HTML fetches before first paint: the module itself plus
 * each `modulepreload` sibling rollup hoisted out of it. Read from the HTML, so
 * the measured set cannot drift away from what a browser downloads.
 */
export function firstLoadScripts(dist: string): Script[] {
  const html = readFileSync(`${dist}/index.html`, 'utf8');
  const paths = new Set(
    [...html.matchAll(/(?:src|href)="\/([^"]+\.js)"/g)].map((match) => match[1] as string),
  );
  if (paths.size === 0) throw new Error(`no scripts referenced by ${dist}/index.html`);
  return [...paths].map((path) => ({
    name: path,
    gzip: gzipSync(readFileSync(`${dist}/${path}`)).length,
  }));
}

export function firstLoadGzip(dist: string): number {
  return firstLoadScripts(dist).reduce((total, script) => total + script.gzip, 0);
}

/** Per-chunk sizes, biggest first — so a regression says WHICH chunk grew. */
export function firstLoadBreakdown(dist: string): string {
  return firstLoadScripts(dist)
    .sort((a, b) => b.gzip - a.gzip)
    .map((script) => `${script.name} ${script.gzip}`)
    .join(', ');
}

/** Markers in the wrong chunk, in either direction. */
function splitBreaches(dist: string): string[] {
  const entry = String(chunkOf(dist, ENTRY_PREFIX));
  const breaches: string[] = [];
  for (const [prefix, markers] of Object.entries(CHUNK_MARKERS)) {
    const own = String(chunkOf(dist, prefix));
    for (const marker of markers) {
      if (entry.includes(marker)) breaches.push(`'${marker}' (${prefix}) ships on the entry chunk`);
      if (!own.includes(marker)) breaches.push(`'${marker}' is no longer in the ${prefix} chunk`);
    }
  }
  return breaches;
}

/** Everything this guard would fail on, for a given build. Empty means the build is in budget. */
export function webBundleBreaches(dist: string): string[] {
  const breaches: string[] = [];
  const firstLoad = firstLoadGzip(dist);
  if (firstLoad >= FIRST_LOAD_MAX_GZIP) {
    breaches.push(
      `first load ${firstLoad} >= ${FIRST_LOAD_MAX_GZIP} B gzipped (${firstLoadBreakdown(dist)})`,
    );
  }
  for (const [prefix, limit] of Object.entries(CHUNK_MAX_GZIP)) {
    const gzip = gzipSync(chunkOf(dist, prefix)).length;
    if (gzip >= limit) breaches.push(`${prefix} chunk ${gzip} >= ${limit} B gzipped`);
  }
  breaches.push(...splitBreaches(dist));
  return breaches;
}
