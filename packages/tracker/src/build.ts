import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * How the tracker is built and what it is allowed to weigh.
 *
 * @guard tracker-bundles
 *
 * The budgets are a ratchet (CLAUDE.md invariant 6): a failure means the bundle
 * grew, not that the number was too small. `bundleBreaches` takes the directory
 * so `test/guards/meta.test.ts` can pad a copy of a built bundle and prove the
 * budget notices.
 */

export interface Bundle {
  /** Served filename (docs/04: `/matomo.js` + `/piwik.js`, `/tracker.js`). */
  file: string;
  entry: string;
  format: 'iife' | 'esm';
  /** Gzipped budget from docs/04. A ratchet: tighten it, never raise it (CLAUDE.md invariant 6). */
  maxGzipBytes: number;
}

export const BUNDLES: readonly Bundle[] = [
  { file: 'matomo.js', entry: 'src/shim/entry.ts', format: 'iife', maxGzipBytes: 3072 },
  { file: 'tracker.js', entry: 'src/native/tracker.ts', format: 'esm', maxGzipBytes: 2048 },
];

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DIST_DIR = `${PACKAGE_ROOT}dist/`;

/** esbuild is a devDependency of apps/server; bun links its binary into that workspace. */
const ESBUILD_PATHS = [
  'node_modules/.bin/esbuild',
  '../../node_modules/.bin/esbuild',
  '../../apps/server/node_modules/.bin/esbuild',
];

export function buildBundle(bundle: Bundle, dir: string = DIST_DIR): string {
  const outfile = join(dir, bundle.file);
  try {
    // Captured rather than inherited: esbuild's size summary is noise inside the test run.
    execFileSync(
      esbuildPath(),
      [
        PACKAGE_ROOT + bundle.entry,
        '--bundle',
        '--minify',
        '--legal-comments=none',
        '--target=es2020',
        `--format=${bundle.format}`,
        `--outfile=${outfile}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (error) {
    const details = (error as { stderr?: Buffer }).stderr ?? error;
    throw new Error(`esbuild failed for ${bundle.file}:\n${details}`);
  }
  return outfile;
}

export function buildAll(dir: string = DIST_DIR): void {
  for (const bundle of BUNDLES) buildBundle(bundle, dir);
}

/**
 * Everything the tracker budget would fail on for the bundles in `dir`: a bundle
 * over its gzipped ceiling, or one that stopped being the module format the
 * `<script>` tag on someone's site expects.
 */
export function bundleBreaches(dir: string): string[] {
  const breaches: string[] = [];
  for (const bundle of BUNDLES) {
    const source = readFileSync(join(dir, bundle.file));
    if (source.length === 0) breaches.push(`${bundle.file} is empty`);
    const gzip = gzipSync(source).length;
    if (gzip >= bundle.maxGzipBytes) {
      breaches.push(`${bundle.file} ${gzip} >= ${bundle.maxGzipBytes} B gzipped`);
    }
    const text = String(source);
    // The shim self-executes on a page that has no module loader; the native
    // tracker is imported. Either one taking the other's shape breaks its callers.
    if (bundle.format === 'iife' && /\bexport\b/.test(text)) {
      breaches.push(`${bundle.file} must self-execute, but exports`);
    }
    if (bundle.format === 'esm' && !/export\{[^}]*init/.test(text)) {
      breaches.push(`${bundle.file} must export init`);
    }
  }
  return breaches;
}

function esbuildPath(): string {
  for (const candidate of ESBUILD_PATHS) {
    const path = PACKAGE_ROOT + candidate;
    if (existsSync(path)) return path;
  }
  throw new Error(`esbuild binary not found; looked in ${ESBUILD_PATHS.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildAll();
