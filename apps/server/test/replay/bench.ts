import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSite, openDb, withWriteTransaction } from '../../src/db/index.ts';
import { parseMatomoRequest } from '../../src/ingest/matomo.ts';
import { createPipeline } from '../../src/pipeline/index.ts';
import {
  type IngestMeasurement,
  ingestBreaches,
  loadThresholds,
  overDocsBudget,
  type ReadMeasurement,
  readBreaches,
  type Thresholds,
} from './bench.guard.ts';
import { generateCorpus, REPLAY_GEO, REPLAY_HITS_PER_FLUSH, toMatomoQuery } from './generate.ts';
import { measureReads } from './read.ts';

/**
 * The perf gate (docs/02 § Performance budget, docs/08 WP6): replays the whole
 * synthetic corpus through parser → pipeline → batcher into a throwaway file
 * database, measures what ingest costs, then asks that same database the
 * questions a dashboard asks and measures what reads cost. Thresholds live next
 * door in bench-thresholds.json and are a ratchet — they tighten, never loosen
 * (CLAUDE.md invariant 6).
 *
 * Reads ride the ingest corpus deliberately: it is already written, already 90
 * days across six sites, and already on disk rather than in memory, so the read
 * budget costs the queries and nothing else.
 *
 * Run it with `bun run bench`.
 */

/** Long enough that only the explicit flushes below ever run. */
const MANUAL_FLUSH_INTERVAL_MS = 3_600_000;

interface Measurement {
  ingest: IngestMeasurement;
  reads: ReadMeasurement[];
}

function main(): void {
  const thresholds = loadThresholds();
  const measurement = measure();
  report(measurement, thresholds);
}

function measure(): Measurement {
  const generateStarted = performance.now();
  const corpus = generateCorpus();
  const generateMs = performance.now() - generateStarted;

  const dir = mkdtempSync(join(tmpdir(), 'analytics-bench-'));
  const path = join(dir, 'bench.db');
  const db = openDb(path);
  try {
    withWriteTransaction(db, () => {
      for (const site of corpus.sites) createSite(db, site);
    });
    // Same geo the test replays use (`harness.ts`): the storage figure below
    // must describe the rows the suite actually asserts against, geo included.
    const pipeline = createPipeline(db, {
      geo: REPLAY_GEO,
      batchIntervalMs: MANUAL_FLUSH_INTERVAL_MS,
    });
    const flushMs: number[] = [];
    let queued = 0;

    const started = performance.now();
    for (const entry of corpus.hits) {
      const { hits } = parseMatomoRequest({ query: toMatomoQuery(entry) });
      pipeline.sink(hits, entry.ctx);
      queued += 1;
      if (queued === REPLAY_HITS_PER_FLUSH) {
        queued = 0;
        flushMs.push(timed(() => pipeline.flush()));
      }
    }
    flushMs.push(timed(() => pipeline.flush()));
    const ingestMs = performance.now() - started;
    pipeline.shutdown();

    const stored = db.prepare('SELECT COUNT(*) FROM events').pluck().get() as number;
    if (stored !== corpus.storedHits) {
      throw new Error(`bench replay stored ${stored} events, expected ${corpus.storedHits}`);
    }

    // Reads, on the corpus ingest just wrote — before the close, so the storage
    // figure below still describes a settled database.
    const reads = measureReads(db, corpus);
    db.close();

    const total = flushMs.reduce((sum, ms) => sum + ms, 0);
    return {
      ingest: {
        hits: corpus.hits.length,
        stored,
        generateMs,
        ingestMs,
        hitsPerSec: (corpus.hits.length / ingestMs) * 1000,
        flushes: flushMs.length,
        meanFlushMs: total / flushMs.length,
        maxFlushMs: Math.max(...flushMs),
        bytesPerEvent: statSync(path).size / stored,
      },
      reads,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function timed(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function report({ ingest, reads }: Measurement, thresholds: Thresholds): void {
  const lines = [
    ['hits offered', `${ingest.hits}`],
    ['events stored', `${ingest.stored}`],
    ['corpus generated in', `${ingest.generateMs.toFixed(0)} ms (not measured below)`],
    ['ingest wall time', `${ingest.ingestMs.toFixed(0)} ms`],
    ['throughput', `${ingest.hitsPerSec.toFixed(0)} hits/sec`],
    ['per hit', `${((ingest.ingestMs / ingest.hits) * 1000).toFixed(1)} µs`],
    ['batch flushes', `${ingest.flushes} × ${REPLAY_HITS_PER_FLUSH} hits`],
    ['flush mean / max', `${fmt(ingest.meanFlushMs)} / ${fmt(ingest.maxFlushMs)} ms`],
    ['db size', `${ingest.bytesPerEvent.toFixed(0)} bytes/event`],
  ];
  console.log('replay bench — ingest');
  for (const [label, value] of lines) console.log(`  ${(label ?? '').padEnd(21)}${value}`);

  console.log('replay bench — read');
  for (const read of reads) {
    const budget = thresholds.read.maxMedianMs[read.name];
    console.log(
      `  ${read.name.padEnd(38)}${fmt(read.medianMs).padStart(8)} ms  ` +
        `(slowest ${fmt(read.slowestMs)}, ${read.rows} rows, ${read.bytes} B, budget ${budget ?? '—'})`,
    );
  }

  for (const over of overDocsBudget(reads, thresholds.read)) {
    console.log(`  OVER DOCS/02 BUDGET ${over}`);
  }

  const breaches = [
    ...ingestBreaches(ingest, thresholds.ingest),
    ...readBreaches(reads, thresholds.read),
  ];
  if (breaches.length === 0) {
    console.log('  budget              ok');
    return;
  }
  for (const breach of breaches) console.error(`  BUDGET BREACH       ${breach}`);
  process.exitCode = 1;
}

function fmt(ms: number): string {
  return ms.toFixed(2);
}

main();
