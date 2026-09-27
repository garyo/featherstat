import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * CLAUDE.md invariant 10 as a scan: **every history-rewriting job bumps
 * `data_epoch`**.
 *
 * @guard epoch-discipline
 *
 * `dataVersion` is `epoch · 2^40 + MAX(events.id)` (db/index.ts): appends move
 * the high-water mark, but a job that rewrites or deletes stored rows in place
 * leaves it still — and every ETag minted before the rewrite would answer 304
 * forever. So each rewriter must call `bumpDataEpoch` after its last chunk.
 *
 * The scan reads every job source under `apps/server/src/jobs`, subdirectories
 * included, and asks two
 * questions of each: does it look like it rewrites history (an UPDATE/DELETE
 * against events, sessions, or a `${table}` template over them), and does it
 * bump the epoch? `REWRITERS` names the files that must do both; anything else
 * that matches the rewrite shape needs either the bump + a REWRITERS entry, or
 * an explained exemption. The backfills bump through `settleRewrite`, the
 * shared rebuild-then-bump epilogue in rewrite.ts, which the scan then holds
 * to a bump of its own (`DELEGATED_BUMPS`).
 *
 * The scan takes its files as an argument so `test/guards/inventory.ts` can
 * hand it a mutated set and check that this actually objects.
 */

const JOBS_DIR = fileURLToPath(new URL('../../src/jobs', import.meta.url));

export interface JobSource {
  /** Path within `apps/server/src/jobs`, `/`-separated. */
  name: string;
  source: string;
}

/** Every job implementation (tests excluded — they quote SQL to assert on it). */
export function jobSources(dir: string = JOBS_DIR): JobSource[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => ({
      name: name.split(sep).join('/'),
      source: readFileSync(join(dir, name), 'utf8'),
    }));
}

/**
 * The shape of an in-place history rewrite, template-table variants included —
 * and a rollup rebuild, which rewrites the derived history queries answer from
 * (reconcile's repair path replaces rows a cached ETag was computed against).
 */
const HISTORY_REWRITE =
  /\b(?:UPDATE|DELETE\s+FROM)\s+(?:(?:events|sessions)\b|\$\{table\})|\brebuildRollupDay\s*\(/;

/** The call every rewriter must make after its last chunk commits. */
const EPOCH_BUMP = 'bumpDataEpoch(';

/** Calls that bump on a rewriter's behalf, each with the job file that must bump itself. */
const DELEGATED_BUMPS: Readonly<Record<string, string>> = {
  'settleRewrite(': 'rewrite.ts',
};

function bumps(source: string): boolean {
  return (
    source.includes(EPOCH_BUMP) ||
    Object.keys(DELEGATED_BUMPS).some((call) => source.includes(call))
  );
}

/** The known rewrite entry points. A new one is added HERE, with its bump. */
const REWRITERS = [
  'campaign-backfill.ts',
  'referrer-backfill.ts',
  'prop-scrub.ts',
  'site-purge.ts',
  'reconcile.ts',
  'timezone-backfill.ts',
] as const;

/**
 * Files that match the rewrite shape but legitimately never bump. Each needs a
 * reason; an empty entry is not allowed.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'retention.ts':
    'deletes only rows below the raw horizon it records first — the query engine ' +
    'refuses to answer under that floor, so pruned history is refused, never re-served stale',
};

/** The guard is worth exactly what it reads; below this the walk broke. */
const MIN_JOB_FILES = 10;

/**
 * `source` reprinted without its comments, so a comment that merely mentions
 * `bumpDataEpoch(` — or quotes a DELETE — reads as exactly what it is. The
 * compiler's own printer, not a regex: string and template literals keep
 * every character, however much they look like comment markers.
 */
export function withoutComments(source: string): string {
  const file = ts.createSourceFile('job.ts', source, ts.ScriptTarget.Latest);
  return ts.createPrinter({ removeComments: true }).printFile(file);
}

/** Every way the epoch discipline is currently broken, as one line each. */
export function epochBreaches(files: readonly JobSource[]): string[] {
  const breaches: string[] = [];
  if (files.length < MIN_JOB_FILES) {
    breaches.push(`only ${files.length} job sources scanned — the walk broke`);
  }
  const byName = new Map(files.map((file) => [file.name, withoutComments(file.source)]));

  for (const name of REWRITERS) {
    const code = byName.get(name);
    if (code === undefined) {
      breaches.push(`rewriter ${name} is gone — update REWRITERS with its successor`);
      continue;
    }
    if (!HISTORY_REWRITE.test(code)) {
      breaches.push(
        `${name} no longer matches the rewrite shape — if it stopped rewriting, drop it ` +
          'from REWRITERS; if the SQL moved, teach HISTORY_REWRITE the new shape',
      );
    }
    if (!bumps(code)) {
      breaches.push(`${name} rewrites history without calling bumpDataEpoch — ETags will lie`);
    }
  }

  for (const [call, name] of Object.entries(DELEGATED_BUMPS)) {
    if (!byName.get(name)?.includes(EPOCH_BUMP)) {
      breaches.push(`${name} no longer bumps the epoch — every rewriter calling ${call}) lies`);
    }
  }

  const registered = new Set<string>(REWRITERS);
  for (const [name, code] of byName) {
    if (registered.has(name) || !HISTORY_REWRITE.test(code)) continue;
    const reason = EXEMPT[name];
    if (reason === undefined || reason.length < 20) {
      breaches.push(
        `${name} rewrites events/sessions but is neither in REWRITERS (with a ` +
          'bumpDataEpoch call) nor exempted with a reason in EXEMPT',
      );
    }
  }
  return breaches;
}
