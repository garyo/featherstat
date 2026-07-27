import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DAY_MS } from '@analytics/shared';
import {
  generateCorpus,
  REPLAY_HITS_PER_FLUSH,
  toMatomoQuery,
} from '../../test/replay/generate.ts';
import { createSite, openDb, withWriteTransaction } from '../db/index.ts';
import { parseMatomoRequest } from '../ingest/matomo.ts';
import { createPipeline } from '../pipeline/index.ts';

/**
 * Fills a development database with something worth looking at: the replay
 * corpus (docs/08 WP6) — 90 days of shaped traffic across the six sites of
 * docs/01 — pushed through the real parser, pipeline and batcher.
 *
 * The window ends today rather than at the generator's fixed epoch, so every
 * range preset lands on data and "today" is a partial day like a live install's.
 * Everything else is the generator's, unchanged: same seed, same traffic.
 *
 *   bun run --cwd apps/server seed
 */

const DAYS = 90;
const DEFAULT_PATH = 'data/dev.db';
/** Long enough that only the explicit flushes below ever run (as in the bench). */
const MANUAL_FLUSH_INTERVAL_MS = 3_600_000;

function main(): void {
  const path = process.env.DB_PATH ?? DEFAULT_PATH;
  const now = Date.now();
  const startMs = utcMidnight(now) - (DAYS - 1) * DAY_MS;

  const corpus = generateCorpus({ days: DAYS, startMs });
  reset(path);
  mkdirSync(dirname(path), { recursive: true });

  const db = openDb(path);
  const started = performance.now();
  try {
    withWriteTransaction(db, () => {
      for (const site of corpus.sites) createSite(db, site);
    });

    const pipeline = createPipeline(db, { batchIntervalMs: MANUAL_FLUSH_INTERVAL_MS });
    let offered = 0;
    let queued = 0;
    for (const entry of corpus.hits) {
      if (entry.ctx.receivedAt > now) break; // ascending: the rest is the future
      const { hits } = parseMatomoRequest({ query: toMatomoQuery(entry) });
      pipeline.sink(hits, entry.ctx);
      offered += 1;
      queued += 1;
      if (queued === REPLAY_HITS_PER_FLUSH) {
        queued = 0;
        pipeline.flush();
      }
    }
    pipeline.shutdown();

    const stored = db.prepare('SELECT COUNT(*) FROM events').pluck().get() as number;
    const elapsed = Math.round(performance.now() - started);
    console.log(`seeded ${path}`);
    console.log(`  sites          ${corpus.sites.map((site) => site.id).join(', ')}`);
    console.log(`  days           ${DAYS}, ending ${new Date(now).toISOString().slice(0, 10)}`);
    console.log(`  hits offered   ${offered}`);
    console.log(`  events stored  ${stored} (the rest were bots, as designed)`);
    console.log(`  took           ${elapsed} ms`);
  } finally {
    db.close();
  }
}

/** Seeding is a fresh start: site ids and the corpus must not stack on a previous run. */
function reset(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

function utcMidnight(ms: number): number {
  return ms - (ms % DAY_MS);
}

main();
