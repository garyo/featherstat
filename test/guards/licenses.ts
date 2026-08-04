import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * The licence of everything featherstat ships, derived from what is installed
 * rather than remembered.
 *
 * @guard licenses
 *
 * CLAUDE.md records the trap in prose: `ua-parser-js` must stay on v1 because v2
 * relicensed to AGPL. A rule enforced by memory is exactly the failure mode this
 * work exists to remove — nothing would have caught a `^1` becoming `^2`, and an
 * MIT project that has already gone public cannot take that back. So: walk the
 * real production dependency tree, read each package's own declared licence, and
 * fail on anything that is not permissive.
 *
 * Fail-closed by design. An unrecognised licence is a failure, not a pass: the
 * point is to force a decision at the moment a dependency arrives, and every
 * copyleft licence in existence is "unrecognised" to this list.
 *
 * No new dependency to do it (there are good licence-checkers; adding one to
 * check licences is its own joke). The inputs are `package.json` files that are
 * already on disk.
 */

/**
 * SPDX identifiers compatible with shipping inside an MIT project. Matched
 * exactly, never case-folded: `Unlicense` is a public-domain dedication and
 * `UNLICENSED` is npm's marker for "proprietary, do not publish", and one
 * lowercase comparison away from each other.
 */
const PERMISSIVE: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/**
 * devDependencies whose code is compiled INTO something we ship, and which are
 * therefore production dependencies of the artifact whatever the manifest calls
 * them: the SPA carries Svelte's runtime. Checked exactly like a real dependency,
 * transitively.
 */
const BUNDLED_DEV_DEPENDENCIES: readonly string[] = ['svelte'];

/**
 * devDependencies that only ever run on a developer's machine or in CI — nothing
 * they contain reaches a user — so their licences do not bind what we may ship.
 *
 * The two lists together must cover every devDependency of every workspace. That
 * is the mechanism: a new build tool fails this gate until someone says which
 * kind it is, and the question "does this ship?" gets asked once, on arrival,
 * instead of never.
 */
const BUILD_ONLY_DEV_DEPENDENCIES: readonly string[] = [
  '@biomejs/biome',
  // Drives a browser against the built app in `test/e2e`; Apache-2.0, and none
  // of it is bundled — the SPA never imports it.
  '@playwright/test',
  '@sveltejs/vite-plugin-svelte',
  '@types/better-sqlite3',
  '@types/node',
  'esbuild',
  'happy-dom',
  'svelte-check',
  'typescript',
  'vite',
  'vitest',
];

export interface InstalledPackage {
  name: string;
  version: string;
  /** The SPDX expression the package declares; `undefined` when it declares none. */
  license: string | undefined;
  /** What pulled it in, for the failure message. */
  via: string;
  dir: string;
}

interface Manifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
  private?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
}

/** Workspace directories, absolute, in manifest order. Supports the `dir/*` form we use. */
function workspaceDirs(root: string): string[] {
  const globs = stringArray(manifestAt(join(root, 'package.json')).workspaces);
  return globs.flatMap((pattern) => {
    if (!pattern.endsWith('/*'))
      return existsSync(join(root, pattern)) ? [join(root, pattern)] : [];
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) return [];
    return readdirSync(parent)
      .map((name) => join(parent, name))
      .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')));
  });
}

/**
 * Every package whose code can reach a user: the transitive closure of each
 * workspace's `dependencies`, plus `BUNDLED_DEV_DEPENDENCIES`.
 *
 * `optionalDependencies` are followed when installed (a platform binary that is
 * present ships) and ignored when not. `peerDependencies` are not: they are a
 * compatibility statement about something resolved elsewhere, and the only one
 * in this tree is `@types/node`, which is types and emits nothing.
 */
export function productionTree(root: string): InstalledPackage[] {
  const workspaces = workspaceDirs(root);
  const found = new Map<string, InstalledPackage>();
  const queue: { from: string; name: string; via: string }[] = [];

  for (const dir of workspaces) {
    const via = relative(root, dir) || '.';
    for (const name of Object.keys(record(manifestAt(join(dir, 'package.json')).dependencies))) {
      queue.push({ from: dir, name, via });
    }
  }
  for (const name of BUNDLED_DEV_DEPENDENCIES) {
    const from = workspaces.find(
      (dir) => name in record(manifestAt(join(dir, 'package.json')).devDependencies),
    );
    if (from !== undefined) queue.push({ from, name, via: `${relative(root, from)} (bundled)` });
  }

  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const manifestPath = resolveFrom(next.from, next.name, root);
    if (manifestPath === undefined) {
      throw new Error(`'${next.name}' (from ${next.via}) is not installed — run \`bun install\``);
    }
    if (found.has(manifestPath)) continue;
    const manifest = manifestAt(manifestPath);
    const name = typeof manifest.name === 'string' ? manifest.name : next.name;
    found.set(manifestPath, {
      name,
      version: typeof manifest.version === 'string' ? manifest.version : '?',
      license: declaredLicense(manifest),
      via: next.via,
      dir: dirname(manifestPath),
    });
    const owner = dirname(manifestPath);
    for (const dependency of Object.keys(record(manifest.dependencies))) {
      queue.push({ from: owner, name: dependency, via: name });
    }
    for (const dependency of Object.keys(record(manifest.optionalDependencies))) {
      // Present means it ships; absent means this platform never loads it.
      if (resolveFrom(owner, dependency, root) !== undefined) {
        queue.push({ from: owner, name: dependency, via: name });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every reason this tree could not be published under MIT. Empty means it can. */
export function licenseFindings(root: string): string[] {
  const findings: string[] = [];
  for (const installed of productionTree(root)) {
    if (installed.license === undefined) {
      findings.push(
        `${installed.name}@${installed.version} declares no licence (via ${installed.via})`,
      );
      continue;
    }
    if (!isPermissive(installed.license)) {
      findings.push(
        `${installed.name}@${installed.version} is '${installed.license}', which is not MIT-compatible (via ${installed.via})`,
      );
    }
  }
  return findings;
}

/** Every workspace manifest must say MIT out loud — the repo LICENSE is not inherited by npm. */
export function workspaceLicenseFindings(root: string): string[] {
  const findings: string[] = [];
  for (const dir of [root, ...workspaceDirs(root)]) {
    const manifest = manifestAt(join(dir, 'package.json'));
    if (manifest.license !== 'MIT') {
      findings.push(
        `${relative(root, dir) || '.'}/package.json declares license ${JSON.stringify(manifest.license) ?? 'nothing'}, expected "MIT"`,
      );
    }
  }
  return findings;
}

/**
 * devDependencies nobody has classified as shipping or not shipping. The gate
 * that keeps `productionTree` honest: a bundled runtime hiding in
 * devDependencies is a licence this file never reads.
 */
export function unclassifiedDevDependencies(root: string): string[] {
  const known = new Set([...BUNDLED_DEV_DEPENDENCIES, ...BUILD_ONLY_DEV_DEPENDENCIES]);
  const findings: string[] = [];
  for (const dir of [root, ...workspaceDirs(root)]) {
    const manifest = manifestAt(join(dir, 'package.json'));
    for (const name of Object.keys(record(manifest.devDependencies))) {
      if (!known.has(name)) {
        findings.push(
          `${relative(root, dir) || '.'} devDependency '${name}' is unclassified — add it to BUNDLED_DEV_DEPENDENCIES if its code ends up in a shipped bundle, or BUILD_ONLY_DEV_DEPENDENCIES if it only runs here`,
        );
      }
    }
  }
  return findings;
}

/**
 * An SPDX expression, evaluated: `A OR B` needs one permissive operand, `A AND B`
 * needs both, `A WITH exception` is judged on `A`. Anything unparseable or
 * unlisted is not permissive.
 */
export function isPermissive(expression: string): boolean {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  let at = 0;

  // Declarations, not arrows: the three are mutually recursive through the
  // parenthesised case, so none of them can be defined after all its callers.
  function parseFactor(): boolean {
    const token = tokens[at];
    if (token === undefined) return false;
    at += 1;
    if (token === '(') {
      const inner = parseOr();
      if (tokens[at] === ')') at += 1;
      return inner;
    }
    if (tokens[at] === 'WITH') at += 2; // the exception narrows a licence; judge the licence
    return PERMISSIVE.has(token.endsWith('+') ? token.slice(0, -1) : token);
  }
  function parseAnd(): boolean {
    let value = parseFactor();
    while (tokens[at] === 'AND') {
      at += 1;
      value = parseFactor() && value;
    }
    return value;
  }
  function parseOr(): boolean {
    let value = parseAnd();
    while (tokens[at] === 'OR') {
      at += 1;
      value = parseAnd() || value;
    }
    return value;
  }

  const result = parseOr();
  return result && at === tokens.length;
}

/** npm has three spellings of this field across its history; all three still occur. */
function declaredLicense(manifest: Manifest): string | undefined {
  if (typeof manifest.license === 'string') return manifest.license;
  if (isRecord(manifest.license) && typeof manifest.license.type === 'string') {
    return manifest.license.type;
  }
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((entry) => (isRecord(entry) && typeof entry.type === 'string' ? entry.type : undefined))
      .filter((type): type is string => type !== undefined);
    if (types.length > 0) return types.join(' OR ');
  }
  return undefined;
}

/** Node resolution, stopped at `root` so nothing outside the repo can be counted as installed. */
function resolveFrom(from: string, name: string, root: string): string | undefined {
  const bound = root.endsWith('/') ? root.slice(0, -1) : root;
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (dir === bound || parent === dir) return undefined;
    dir = parent;
  }
}

function manifestAt(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
