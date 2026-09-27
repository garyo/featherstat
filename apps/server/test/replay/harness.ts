import { createSite, type Db, openDb, withWriteTransaction } from '../../src/db/index.ts';
import { parseMatomoRequest } from '../../src/ingest/matomo.ts';
import { createPipeline, type Pipeline } from '../../src/pipeline/index.ts';
import { type Corpus, REPLAY_GEO, REPLAY_HITS_PER_FLUSH, toMatomoQuery } from './generate.ts';

/**
 * Pushing the corpus through the real stack — the setup five suites had a
 * private copy of, which is how `country` came to be NULL in all of them at
 * once: the pipeline takes its geo provider as an option, and nowhere in the
 * five did anyone pass one.
 *
 * Deliberately NOT shared with `bench.ts`, which times each flush individually
 * and measures the ingest loop's wall clock; folding its instrumentation in here
 * would either distort the measurement or complicate this. It reads `REPLAY_GEO`
 * from the same place, so the two still ingest the same corpus.
 */

/** Long enough that only the explicit flushes below ever land. */
const MANUAL_FLUSH_INTERVAL_MS = 3_600_000;

export interface ReplayOptions {
  /** Defaults to a batch interval so long that only `onBatch` flushes. */
  batchIntervalMs?: number;
  /**
   * Runs every `REPLAY_HITS_PER_FLUSH` hits instead of a plain flush — what
   * `replay.test.ts` uses to drive the REAL 200 ms batch timer under fake
   * timers, so the batcher's own scheduling is what is under test there.
   */
  onBatch?: (pipeline: Pipeline) => void;
}

function replayCorpus(db: Db, corpus: Corpus, options: ReplayOptions = {}): void {
  const pipeline = createPipeline(db, {
    geo: REPLAY_GEO,
    batchIntervalMs: options.batchIntervalMs ?? MANUAL_FLUSH_INTERVAL_MS,
  });
  const onBatch = options.onBatch ?? ((target: Pipeline) => target.flush());
  let queued = 0;
  for (const entry of corpus.hits) {
    const { hits } = parseMatomoRequest({ query: toMatomoQuery(entry) });
    pipeline.sink(hits, entry.ctx);
    queued += 1;
    if (queued === REPLAY_HITS_PER_FLUSH) {
      queued = 0;
      onBatch(pipeline);
    }
  }
  pipeline.shutdown(); // stops the timer and flushes the tail
}

/** A fresh in-memory database holding the corpus's sites and its whole replay. */
export function openReplayDb(corpus: Corpus, options: ReplayOptions = {}): Db {
  const db = openDb(':memory:');
  withWriteTransaction(db, () => {
    for (const site of corpus.sites) createSite(db, site);
  });
  replayCorpus(db, corpus, options);
  return db;
}
