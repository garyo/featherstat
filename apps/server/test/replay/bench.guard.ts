import { readFileSync } from 'node:fs';

/**
 * The perf gate's thresholds and the arithmetic that decides a breach — the two
 * halves of `bun run bench` that have to be callable without running the bench,
 * so `test/guards/` can hand them a measurement that violates each threshold and
 * check the gate actually says so (CLAUDE.md invariant 6: a ratchet nobody has
 * seen fail is a ratchet nobody knows still binds).
 *
 * @guard perf-ingest
 * @guard perf-read
 *
 * Both sections are ratchets: they tighten, never loosen. `read` also carries
 * docs/02's dashboard budget, which today's slowest shapes exceed — see
 * `overDocsBudget` for why that is reported rather than enforced.
 */

const THRESHOLDS_PATH = new URL('./bench-thresholds.json', import.meta.url);

export interface IngestThresholds {
  minHitsPerSec: number;
  /** Steady-state cost of one batch transaction; this is the number that matters. */
  maxMeanFlushMs: number;
  /** Loose on purpose: WAL auto-checkpoints land inside a single flush every few MB. */
  maxFlushMs: number;
  /** Storage growth gate — docs/03 budgets ≈ 250–350 B per event row incl. indexes. */
  maxBytesPerEvent: number;
}

export interface ReadThresholds {
  /**
   * docs/02's "dashboard server time (full widget batch, p95) < 50 ms". Advisory
   * here, not enforced: three shapes are over it today (see docs/02) and pinning
   * CI to it would mean either a red gate or quietly deleting the budget. It is
   * printed for every shape that exceeds it so the gap stays visible.
   */
  dashboardBudgetMs: number;
  /**
   * The enforced ratchet, per shape: measured median × ~3, the headroom the
   * ingest thresholds already use, because CI hardware is slower than the
   * machine these were measured on. Every measured shape needs an entry and
   * every entry needs a measurement — see `readBreaches`.
   */
  maxMedianMs: Record<string, number>;
}

export interface Thresholds {
  ingest: IngestThresholds;
  read: ReadThresholds;
}

export interface IngestMeasurement {
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

export interface ReadMeasurement {
  name: string;
  /** Median of the timed repetitions — the number the ratchet compares. */
  medianMs: number;
  slowestMs: number;
  /** Rows across every result, so a timing change can be read against a size change. */
  rows: number;
  bytes: number;
}

export function ingestBreaches(
  measurement: IngestMeasurement,
  thresholds: IngestThresholds,
): string[] {
  const breaches: string[] = [];
  if (measurement.hitsPerSec < thresholds.minHitsPerSec) {
    breaches.push(
      `throughput ${measurement.hitsPerSec.toFixed(0)} < ${thresholds.minHitsPerSec} hits/sec`,
    );
  }
  if (measurement.meanFlushMs > thresholds.maxMeanFlushMs) {
    breaches.push(`mean flush ${ms(measurement.meanFlushMs)} > ${thresholds.maxMeanFlushMs} ms`);
  }
  if (measurement.maxFlushMs > thresholds.maxFlushMs) {
    breaches.push(`slowest flush ${ms(measurement.maxFlushMs)} > ${thresholds.maxFlushMs} ms`);
  }
  if (measurement.bytesPerEvent > thresholds.maxBytesPerEvent) {
    breaches.push(
      `db size ${measurement.bytesPerEvent.toFixed(0)} > ${thresholds.maxBytesPerEvent} bytes/event`,
    );
  }
  return breaches;
}

/**
 * A breach for every shape over its ratchet — and for every shape whose name and
 * threshold do not pair up.
 *
 * That second half is the point. The bundle ratchet spent a month passing while
 * measuring a file that had stopped being the thing it named; the failure mode of
 * a budget is not usually a number that is too high, it is a number nobody
 * compares against anything. A threshold with no measurement means a shape
 * silently stopped being run; a measurement with no threshold means a shape was
 * added and nothing bounds it.
 */
export function readBreaches(
  measurements: readonly ReadMeasurement[],
  thresholds: ReadThresholds,
): string[] {
  const breaches: string[] = [];
  const measured = new Set(measurements.map((measurement) => measurement.name));
  for (const name of Object.keys(thresholds.maxMedianMs)) {
    if (!measured.has(name)) breaches.push(`'${name}' has a threshold but was never measured`);
  }
  for (const measurement of measurements) {
    const limit = thresholds.maxMedianMs[measurement.name];
    if (limit === undefined) {
      breaches.push(`'${measurement.name}' was measured but nothing budgets it`);
      continue;
    }
    if (measurement.medianMs > limit) {
      breaches.push(`'${measurement.name}' ${ms(measurement.medianMs)} > ${limit} ms`);
    }
  }
  return breaches;
}

/** Shapes outside docs/02's dashboard budget — reported, never enforced. */
export function overDocsBudget(
  measurements: readonly ReadMeasurement[],
  thresholds: ReadThresholds,
): string[] {
  return measurements
    .filter((measurement) => measurement.medianMs > thresholds.dashboardBudgetMs)
    .map(
      (measurement) =>
        `'${measurement.name}' ${ms(measurement.medianMs)} > ${thresholds.dashboardBudgetMs} ms`,
    );
}

export function loadThresholds(path: URL | string = THRESHOLDS_PATH): Thresholds {
  const record = object(JSON.parse(readFileSync(path, 'utf8')), 'bench-thresholds.json');
  const ingest = object(record.ingest, 'ingest');
  const read = object(record.read, 'read');
  const maxMedianMs = object(read.maxMedianMs, 'read.maxMedianMs');
  return {
    ingest: {
      minHitsPerSec: positive(ingest, 'minHitsPerSec'),
      maxMeanFlushMs: positive(ingest, 'maxMeanFlushMs'),
      maxFlushMs: positive(ingest, 'maxFlushMs'),
      maxBytesPerEvent: positive(ingest, 'maxBytesPerEvent'),
    },
    read: {
      dashboardBudgetMs: positive(read, 'dashboardBudgetMs'),
      maxMedianMs: Object.fromEntries(
        Object.keys(maxMedianMs).map((shape) => [shape, positive(maxMedianMs, shape)]),
      ),
    },
  };
}

function ms(value: number): string {
  return value.toFixed(2);
}

/**
 * Hand-rolled rather than zod: the thresholds file is the bench's private config,
 * not a cross-package contract, and `apps/server` deliberately has no zod
 * dependency to reach for (schemas live in `@featherstat/shared`).
 */
function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`bench-thresholds.json: ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positive(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`bench-thresholds.json: ${key} must be a positive number`);
  }
  return value;
}
