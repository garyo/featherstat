import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSite, openDb, withWriteTransaction } from '../../src/db/index.ts';
import { parseMatomoRequest } from '../../src/ingest/matomo.ts';
import { createPipeline } from '../../src/pipeline/index.ts';
import { generateCorpus, REPLAY_HITS_PER_FLUSH, toMatomoQuery } from './generate.ts';

/**
 * The perf gate (docs/02 § Performance budget, docs/08 WP6): replays the whole
 * synthetic corpus through parser → pipeline → batcher into a throwaway file
 * database and measures what ingest actually costs. Thresholds live next door in
 * bench-thresholds.json and are a ratchet — they tighten, never loosen
 * (CLAUDE.md invariant 6).
 *
 * Run it with `bun run bench`.
 */

const THRESHOLDS_PATH = new URL('./bench-thresholds.json', import.meta.url);

/** Long enough that only the explicit flushes below ever run. */
const MANUAL_FLUSH_INTERVAL_MS = 3_600_000;

interface Thresholds {
  minHitsPerSec: number;
  /** Steady-state cost of one batch transaction; this is the number that matters. */
  maxMeanFlushMs: number;
  /** Loose on purpose: WAL auto-checkpoints land inside a single flush every few MB. */
  maxFlushMs: number;
  /** Storage growth gate — docs/03 budgets ≈ 250–350 B per event row incl. indexes. */
  maxBytesPerEvent: number;
}

interface Measurement {
  hits: number;
  stored: number;
  generateMs: number;
  ingestMs: number;
  hitsPerSec: number;
  flushes: number;
  meanFlushMs: number;
  maxFlushMs: number;
  bytesPerEvent: number;
}

function main(): void {
  const thresholds = readThresholds();
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
    const pipeline = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_INTERVAL_MS });
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
    db.close();

    const total = flushMs.reduce((sum, ms) => sum + ms, 0);
    return {
      hits: corpus.hits.length,
      stored,
      generateMs,
      ingestMs,
      hitsPerSec: (corpus.hits.length / ingestMs) * 1000,
      flushes: flushMs.length,
      meanFlushMs: total / flushMs.length,
      maxFlushMs: Math.max(...flushMs),
      bytesPerEvent: statSync(path).size / stored,
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

function report(measurement: Measurement, thresholds: Thresholds): void {
  const lines = [
    ['hits offered', `${measurement.hits}`],
    ['events stored', `${measurement.stored}`],
    ['corpus generated in', `${measurement.generateMs.toFixed(0)} ms (not measured below)`],
    ['ingest wall time', `${measurement.ingestMs.toFixed(0)} ms`],
    ['throughput', `${measurement.hitsPerSec.toFixed(0)} hits/sec`],
    ['per hit', `${((measurement.ingestMs / measurement.hits) * 1000).toFixed(1)} µs`],
    ['batch flushes', `${measurement.flushes} × ${REPLAY_HITS_PER_FLUSH} hits`],
    ['flush mean / max', `${fmt(measurement.meanFlushMs)} / ${fmt(measurement.maxFlushMs)} ms`],
    ['db size', `${measurement.bytesPerEvent.toFixed(0)} bytes/event`],
  ];
  console.log('replay bench');
  for (const [label, value] of lines) console.log(`  ${(label ?? '').padEnd(21)}${value}`);

  const breaches = [
    measurement.hitsPerSec < thresholds.minHitsPerSec
      ? `throughput ${measurement.hitsPerSec.toFixed(0)} < ${thresholds.minHitsPerSec} hits/sec`
      : undefined,
    measurement.meanFlushMs > thresholds.maxMeanFlushMs
      ? `mean flush ${fmt(measurement.meanFlushMs)} > ${thresholds.maxMeanFlushMs} ms`
      : undefined,
    measurement.maxFlushMs > thresholds.maxFlushMs
      ? `slowest flush ${fmt(measurement.maxFlushMs)} > ${thresholds.maxFlushMs} ms`
      : undefined,
    measurement.bytesPerEvent > thresholds.maxBytesPerEvent
      ? `db size ${measurement.bytesPerEvent.toFixed(0)} > ${thresholds.maxBytesPerEvent} bytes/event`
      : undefined,
  ].filter((breach) => breach !== undefined);

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

/**
 * Hand-rolled rather than zod: the thresholds file is this script's private
 * config, not a cross-package contract, and `apps/server` deliberately has no
 * zod dependency to reach for (schemas live in `@analytics/shared`).
 */
function readThresholds(): Thresholds {
  const parsed: unknown = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('bench-thresholds.json must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const number = (key: keyof Thresholds): number => {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`bench-thresholds.json: ${key} must be a positive number`);
    }
    return value;
  };
  return {
    minHitsPerSec: number('minHitsPerSec'),
    maxMeanFlushMs: number('maxMeanFlushMs'),
    maxFlushMs: number('maxFlushMs'),
    maxBytesPerEvent: number('maxBytesPerEvent'),
  };
}

main();
