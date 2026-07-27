import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

export function buildBundle(bundle: Bundle): string {
  const outfile = DIST_DIR + bundle.file;
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

export function buildAll(): void {
  for (const bundle of BUNDLES) buildBundle(bundle);
}

function esbuildPath(): string {
  for (const candidate of ESBUILD_PATHS) {
    const path = PACKAGE_ROOT + candidate;
    if (existsSync(path)) return path;
  }
  throw new Error(`esbuild binary not found; looked in ${ESBUILD_PATHS.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildAll();
