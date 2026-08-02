import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryResponse } from '@featherstat/shared';
import {
  epochBreaches,
  type JobSource,
  jobSources,
} from '../../apps/server/test/guards/epoch.guard.ts';
import { CORPUS_DIR, corpusBreaches } from '../../apps/server/test/matomo-corpus.guard.ts';
import {
  type IngestMeasurement,
  ingestBreaches,
  loadThresholds,
  type ReadMeasurement,
  readBreaches,
  type Thresholds,
} from '../../apps/server/test/replay/bench.guard.ts';
import {
  buildWeb,
  chunkFileOf,
  ENTRY_PREFIX,
  firstLoadScripts,
  webBundleBreaches,
} from '../../apps/web/src/build.guard.ts';
import {
  ownershipBreaches,
  type SourceFile,
  webSourceFiles,
} from '../../apps/web/src/ownership.guard.ts';
import { buildAll, bundleBreaches } from '../../packages/tracker/src/build.ts';
import { responseSizeBreaches } from '../contract/response-size.guard.ts';
import {
  licenseFindings,
  unclassifiedDevDependencies,
  workspaceLicenseFindings,
} from './licenses.ts';

/**
 * Every ratchet, budget and ownership guard in this repo, and — for each one — a
 * way to make the thing it guards untrue.
 *
 * The reason this file exists: on 2026-07-30 the web entry-size ratchet was found
 * to have silently stopped measuring what it named. Rollup had begun hoisting the
 * entry's shared code into preloaded sibling chunks, so a budget reading
 * `index-*.js` watched 16 KB while the browser fetched 71 KB, over its own 64 KiB
 * ceiling, for an unknown length of time. Nothing reported it, because **a
 * passing guard looks exactly like a working one**.
 *
 * That generalises. A guard is code, it has no tests of its own, and it is the
 * one kind of code whose failure mode is silence. So each entry below stages the
 * world its guard reads, breaks it on purpose, and re-runs the guard's OWN
 * check — not a copy of it, the same exported function the real test calls —
 * and `meta.test.ts` fails if the guard reports the world is fine.
 *
 * Adding a guard means adding an entry here, and `meta.test.ts` enforces that
 * too: it scans the tree for `@guard` tags and for budget-shaped constants and
 * fails on any guard that is unregistered, and on any registered guard that
 * cannot state a single way it would fail.
 *
 * Nothing here writes inside the repository. Every world is a temp directory or
 * an in-memory value, so a crashed run cannot leave a mutation behind.
 */

type Tier =
  /** Pure or near-pure; milliseconds. Always runs. */
  | 'cheap'
  /** Builds an artifact to mutate; ~1 s in total. Skipped when `GUARDS=cheap`. */
  | 'artifact';

export interface Guard {
  id: string;
  /** What must be true. A guard that cannot say this in one sentence is a finding. */
  binds: string;
  /** Repo-relative file carrying the `@guard` tag — where the real check lives. */
  source: string;
  tier: Tier;
  /** Named ways the guarded property can become untrue. Never empty. */
  violations: readonly string[];
  /**
   * Stage a fresh world, apply `violation` if given, and run the guard's own
   * check. `true` means the guard is satisfied — which, for a violation, means
   * the guard does not bind.
   */
  probe(violation?: string): boolean;
}

interface GuardSpec<W> {
  id: string;
  binds: string;
  source: string;
  tier: Tier;
  /** A world in which the guarded property holds. Rebuilt per probe, so breaks never leak. */
  stage(): W;
  /** The guard's own check, re-run against this world. */
  holds(world: W): boolean;
  violations: Readonly<Record<string, (world: W) => void>>;
}

function defineGuard<W>(spec: GuardSpec<W>): Guard {
  return {
    id: spec.id,
    binds: spec.binds,
    source: spec.source,
    tier: spec.tier,
    violations: Object.keys(spec.violations),
    probe(violation?: string): boolean {
      const world = spec.stage();
      if (violation !== undefined) {
        const violate = spec.violations[violation];
        if (violate === undefined) throw new Error(`${spec.id}: no violation '${violation}'`);
        violate(world);
      }
      return spec.holds(world);
    },
  };
}

// ---------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'featherstat-guard-'));
  sandboxes.push(dir);
  return dir;
}

export function cleanupSandboxes(): void {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Deterministic bytes gzip cannot shrink — the honest way to make an artifact
 * bigger. Padding with zeroes would compress to nothing and would prove only
 * that the guard tolerates padding, not that it measures size.
 */
function incompressible(bytes: number): string {
  const parts: Buffer[] = [];
  let seed = Buffer.from('featherstat guard padding');
  for (let size = 0; size < bytes; size += 32) {
    seed = createHash('sha256').update(seed).digest();
    parts.push(seed);
  }
  return Buffer.concat(parts).subarray(0, bytes).toString('hex');
}

/** More than any single size budget in the repo, so one helper serves them all. */
const OVERSIZE_BYTES = 96 * 1024;

function pad(file: string): void {
  appendFileSync(file, `\n//${incompressible(OVERSIZE_BYTES)}`);
}

/**
 * A build of the artifact in a temp directory, then a fresh copy of it per probe.
 *
 * Its own build rather than the workspace's `dist/`, because `build.test.ts` is
 * writing there in another vitest worker at this moment and a guard that races
 * the thing it inspects is its own kind of unreliable. Built once and copied
 * after that: the bundler is the slow part, `cp` is not.
 */
function stagedCopy(name: string, build: (dir: string) => void): () => string {
  let pristine: string | undefined;
  return () => {
    if (pristine === undefined) {
      pristine = join(sandbox(), name);
      mkdirSync(pristine, { recursive: true });
      build(pristine);
    }
    const copy = join(sandbox(), name);
    cpSync(pristine, copy, { recursive: true });
    return copy;
  };
}

const stagedWeb = stagedCopy('dist', buildWeb);
const stagedTracker = stagedCopy('tracker', buildAll);

/** A first-load script that is NOT the entry chunk — one of the preloaded siblings. */
function siblingScriptOf(dist: string): string {
  const sibling = firstLoadScripts(dist).find(
    (script) => !script.name.includes(`/${ENTRY_PREFIX}-`),
  );
  if (sibling === undefined) {
    throw new Error('the entry preloads no sibling chunks — the reference case cannot be staged');
  }
  return join(dist, sibling.name);
}

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/** Comfortably inside every ingest threshold, so only a violation moves it out. */
const HEALTHY_INGEST: IngestMeasurement = {
  hits: 141_582,
  stored: 137_487,
  generateMs: 270,
  ingestMs: 8_000,
  hitsPerSec: 17_000,
  flushes: 284,
  meanFlushMs: 9,
  maxFlushMs: 40,
  bytesPerEvent: 287,
};

const perfIngest = defineGuard<{ measurement: IngestMeasurement; thresholds: Thresholds }>({
  id: 'perf-ingest',
  binds: 'ingest stays above its throughput floor and under its flush and bytes-per-event ceilings',
  source: 'apps/server/test/replay/bench.guard.ts',
  tier: 'cheap',
  stage: () => ({ measurement: { ...HEALTHY_INGEST }, thresholds: loadThresholds() }),
  holds: ({ measurement, thresholds }) =>
    ingestBreaches(measurement, thresholds.ingest).length === 0,
  violations: {
    'throughput halves': ({ measurement, thresholds }) => {
      measurement.hitsPerSec = thresholds.ingest.minHitsPerSec / 2;
    },
    'the mean flush doubles past its ceiling': ({ measurement, thresholds }) => {
      measurement.meanFlushMs = thresholds.ingest.maxMeanFlushMs * 2;
    },
    'one flush stalls': ({ measurement, thresholds }) => {
      measurement.maxFlushMs = thresholds.ingest.maxFlushMs * 2;
    },
    'a stored row grows by half': ({ measurement, thresholds }) => {
      measurement.bytesPerEvent = thresholds.ingest.maxBytesPerEvent * 1.5;
    },
  },
});

/** Every budgeted shape, measured at a tenth of its ceiling. */
function healthyReads(thresholds: Thresholds): ReadMeasurement[] {
  return Object.entries(thresholds.read.maxMedianMs).map(([name, limit]) => ({
    name,
    medianMs: limit / 10,
    slowestMs: limit / 8,
    rows: 100,
    bytes: 10_000,
  }));
}

const perfRead = defineGuard<{ measurements: ReadMeasurement[]; thresholds: Thresholds }>({
  id: 'perf-read',
  binds: 'every read shape the app sends answers inside its ratchet, and every shape is measured',
  source: 'apps/server/test/replay/bench.guard.ts',
  tier: 'cheap',
  stage: () => {
    const thresholds = loadThresholds();
    return { measurements: healthyReads(thresholds), thresholds };
  },
  holds: ({ measurements, thresholds }) => readBreaches(measurements, thresholds.read).length === 0,
  violations: {
    'the widest dashboard gets three times slower': ({ measurements, thresholds }) => {
      const slowest = measurements.at(-1);
      if (slowest === undefined) throw new Error('no read shapes to slow down');
      slowest.medianMs = (thresholds.read.maxMedianMs[slowest.name] ?? 0) * 3;
    },
    // The bundle ratchet's own failure mode in the read gate's terms: the budget
    // is still there, the measurement quietly stopped happening.
    'a budgeted shape stops being measured': ({ measurements }) => {
      measurements.pop();
    },
    'a shape is measured that nothing budgets': ({ measurements }) => {
      measurements.push({
        name: 'a shape nobody budgeted',
        medianMs: 1,
        slowestMs: 1,
        rows: 0,
        bytes: 0,
      });
    },
  },
});

const webBundles = defineGuard<string>({
  id: 'web-bundles',
  binds: 'the whole first load, and each split chunk, stays under its gzipped ceiling',
  source: 'apps/web/src/build.guard.ts',
  tier: 'artifact',
  stage: stagedWeb,
  holds: (dist) => webBundleBreaches(dist).length === 0,
  violations: {
    // THE REFERENCE CASE. Before 2026-07-30 the budget read `index-*.js` alone,
    // so 96 KiB landing in a preloaded sibling was invisible to it and the guard
    // passed while the first load sat over its ceiling. Any future measurement
    // that stops covering the whole entry graph fails here the day it does.
    'a preloaded sibling chunk of the entry gains 96 KiB': (dist) => {
      pad(siblingScriptOf(dist));
    },
    'the entry chunk itself gains 96 KiB': (dist) => {
      pad(chunkFileOf(dist, ENTRY_PREFIX));
    },
    'the editor chunk outgrows its budget': (dist) => {
      pad(chunkFileOf(dist, 'editor'));
    },
    'editor markup starts shipping on the view path': (dist) => {
      appendFileSync(chunkFileOf(dist, ENTRY_PREFIX), '\n//"Drag to reorder"');
    },
  },
});

const trackerBundles = defineGuard<string>({
  id: 'tracker-bundles',
  binds: 'each tracker bundle stays under its gzipped ceiling and keeps its module format',
  source: 'packages/tracker/src/build.ts',
  tier: 'artifact',
  stage: stagedTracker,
  holds: (dist) => bundleBreaches(dist).length === 0,
  violations: {
    'the matomo shim outgrows its budget': (dist) => {
      pad(join(dist, 'matomo.js'));
    },
    'the native tracker stops exporting init': (dist) => {
      writeFileSync(join(dist, 'tracker.js'), 'console.log("no exports here")');
    },
  },
});

const markupOwnership = defineGuard<SourceFile[]>({
  id: 'markup-ownership',
  binds: 'each shared rendering is drawn by exactly the file that owns it',
  source: 'apps/web/src/ownership.guard.ts',
  tier: 'cheap',
  stage: () => webSourceFiles(),
  holds: (files) => ownershipBreaches(files).length === 0,
  violations: {
    'a second file grows the ranked-bar markup': (files) => {
      files.push({ name: 'widgets/Forked.svelte', source: '<div class="bar-row">…</div>' });
    },
    'the shared rendering moves and nobody updates the table': (files) => {
      files.splice(
        files.findIndex((file) => file.name === 'widgets/FeedRows.svelte'),
        1,
      );
    },
    // A walk that returns nothing satisfies every "exactly these owners" check by
    // accident — the way this guard would die quietly rather than loudly.
    'the tree walk stops finding files': (files) => {
      files.splice(0, files.length);
    },
  },
});

const matomoCorpus = defineGuard<string>({
  id: 'matomo-corpus',
  binds: 'the golden Matomo corpus only ever gains cases, and every case asserts something',
  source: 'apps/server/test/matomo-corpus.guard.ts',
  tier: 'cheap',
  stage: () => {
    const dir = `${join(sandbox(), 'matomo')}/`;
    cpSync(CORPUS_DIR, dir, { recursive: true });
    return dir;
  },
  holds: (dir) => corpusBreaches(dir).length === 0,
  violations: {
    'a fixture is deleted to make a change pass': (dir) => {
      rmSync(join(dir, firstFixture(dir)));
    },
    'a fixture stops asserting any hit': (dir) => {
      writeFileSync(
        join(dir, firstFixture(dir)),
        JSON.stringify({ name: 'hollowed out', method: 'GET', expectStatus: 200 }),
      );
    },
  },
});

/** Inside every size budget, and structurally well-formed. */
function healthyResponse(): QueryResponse {
  return {
    results: {
      series: {
        rows: [{ day: '2026-03-01', pageviews: 12 }],
        bucket: 'day',
        axis: [{ siteId: 1, keys: ['2026-03-01', '2026-03-02'] }],
      },
    },
    meta: {
      generatedInMs: 1,
      dataVersion: 1,
      windows: [{ siteId: 1, timezone: 'UTC', from: '2026-03-01', to: '2026-03-02' }],
    },
  };
}

const responseSize = defineGuard<QueryResponse>({
  id: 'response-size',
  binds: 'a /api/query answer stays under its byte and axis-key caps, with rows left sparse',
  source: 'test/contract/response-size.guard.ts',
  tier: 'cheap',
  stage: healthyResponse,
  holds: (response) => responseSizeBreaches('staged', response).length === 0,
  violations: {
    'one result outgrows the per-result cap': (response) => {
      response.results.fat = { rows: bulkRows(400) };
    },
    'the batch outgrows its cap across many results': (response) => {
      for (let i = 0; i < 12; i += 1) response.results[`r${i}`] = { rows: bulkRows(120) };
    },
    'a result enumerates more axis keys than the batch allows': (response) => {
      response.results.wide = {
        rows: [],
        bucket: 'hour',
        axis: [{ siteId: 1, keys: Array.from({ length: 1_100 }, (_, i) => `k${i}`) }],
      };
    },
    'rows stop being sparse and get densely filled': (response) => {
      response.results.dense = {
        rows: bulkRows(9),
        bucket: 'day',
        axis: [{ siteId: 1, keys: ['a', 'b'] }],
      };
    },
  },
});

const epochDiscipline = defineGuard<JobSource[]>({
  id: 'epoch-discipline',
  binds: 'every job that rewrites stored history calls bumpDataEpoch, so pre-rewrite ETags expire',
  source: 'apps/server/test/guards/epoch.guard.ts',
  tier: 'cheap',
  stage: () => jobSources(),
  holds: (files) => epochBreaches(files).length === 0,
  violations: {
    'a rewriter stops bumping the epoch': (files) => {
      const scrub = files.find((file) => file.name === 'prop-scrub.ts');
      if (scrub === undefined) throw new Error('prop-scrub.ts not staged');
      scrub.source = scrub.source.replaceAll('bumpDataEpoch', 'neverBumped');
    },
    'a new job rewrites history without registering': (files) => {
      files.push({
        name: 'sneaky-rewrite.ts',
        source: "stmt(db, 'DELETE FROM events WHERE site_id = ?').run(siteId);",
      });
    },
    'the walk stops finding job files': (files) => {
      files.splice(0, files.length);
    },
  },
});

const licenses = defineGuard<string>({
  id: 'licenses',
  binds: 'everything featherstat ships is under a licence an MIT project may ship',
  source: 'test/guards/licenses.ts',
  tier: 'cheap',
  stage: stagedRepo,
  holds: (root) =>
    licenseFindings(root).length === 0 &&
    workspaceLicenseFindings(root).length === 0 &&
    unclassifiedDevDependencies(root).length === 0,
  violations: {
    // CLAUDE.md's trap, mechanised: ua-parser-js v2 relicensed to AGPL, and the
    // only thing standing between `^1` and `^2` was somebody remembering.
    'a dependency relicenses to AGPL under a version bump': (root) => {
      writePackage(join(root, 'node_modules/ua-parser-js'), {
        name: 'ua-parser-js',
        version: '2.0.0',
        license: 'AGPL-3.0-or-later',
      });
    },
    'a transitive dependency is copyleft': (root) => {
      writePackage(join(root, 'node_modules/deep-thing'), {
        name: 'deep-thing',
        version: '1.0.0',
        license: 'GPL-3.0',
      });
      writePackage(join(root, 'node_modules/ua-parser-js'), {
        name: 'ua-parser-js',
        version: '1.0.41',
        license: 'MIT',
        dependencies: { 'deep-thing': '^1' },
      });
    },
    'a dependency declares no licence at all': (root) => {
      writePackage(join(root, 'node_modules/ua-parser-js'), {
        name: 'ua-parser-js',
        version: '1.0.41',
      });
    },
    'a workspace stops declaring MIT': (root) => {
      writePackage(join(root, 'apps/server'), {
        name: '@featherstat/server',
        private: true,
        dependencies: { 'ua-parser-js': '^1' },
      });
    },
    'a devDependency arrives that nobody classified as shipping or not': (root) => {
      writePackage(root, {
        name: 'staged',
        private: true,
        license: 'MIT',
        workspaces: ['apps/*'],
        devDependencies: { 'some-new-bundler': '^1' },
      });
    },
  },
});

export const GUARDS: readonly Guard[] = [
  perfIngest,
  perfRead,
  webBundles,
  trackerBundles,
  markupOwnership,
  matomoCorpus,
  responseSize,
  epochDiscipline,
  licenses,
];

// ---------------------------------------------------------------------------

function firstFixture(dir: string): string {
  const first = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()[0];
  if (first === undefined) throw new Error(`no fixtures staged in ${dir}`);
  return first;
}

/** A row big enough that a handful of them cross a byte budget. */
function bulkRows(count: number): { path: string; pageviews: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `/a-path-long-enough-to-carry-weight/${i}/${'x'.repeat(60)}`,
    pageviews: i,
  }));
}

/**
 * A miniature repository: a root manifest, one workspace, one installed
 * dependency. Small enough to mutate precisely, real enough that `licenses.ts`
 * walks it with exactly the code that walks featherstat.
 */
function stagedRepo(): string {
  const root = sandbox();
  writePackage(root, {
    name: 'staged',
    private: true,
    license: 'MIT',
    workspaces: ['apps/*'],
    devDependencies: {},
  });
  writePackage(join(root, 'apps/server'), {
    name: '@featherstat/server',
    private: true,
    license: 'MIT',
    dependencies: { 'ua-parser-js': '^1' },
  });
  writePackage(join(root, 'node_modules/ua-parser-js'), {
    name: 'ua-parser-js',
    version: '1.0.41',
    license: 'MIT',
  });
  return root;
}

function writePackage(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
}
