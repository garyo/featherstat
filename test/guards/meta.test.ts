import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupSandboxes, GUARDS, type Guard } from './inventory.ts';

/**
 * Guarding the guards.
 *
 * Every ratchet in this repo is load-bearing (CLAUDE.md invariant 6) and, until
 * this file, none of them could show that it still bound anything. The web
 * entry-size budget proved why that matters: it spent an unknown length of time
 * measuring `index-*.js` while the browser fetched four chunks, passing all the
 * while, 11% over the ceiling it named. Nothing was broken, exactly — the guard
 * was simply looking at something that had stopped being the thing.
 *
 * So each guard is mutation-tested against itself: stage the world it reads,
 * break the property it claims to hold, and demand that its own check objects.
 * The specific mutations live in `inventory.ts`; this file is the discipline.
 *
 * Cost: the whole sweep is ~1.2 s, of which ~1.1 s is one vite build and one
 * esbuild run for the two guards that need an artifact to mutate; the remaining
 * six take ~70 ms between them. `GUARDS=cheap` drops the two, and the default is
 * everything, because a guard skipped in CI is a guard back where it started.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RUN_ARTIFACT_TIER = process.env.GUARDS !== 'cheap';

const selected = GUARDS.filter((guard) => RUN_ARTIFACT_TIER || guard.tier === 'cheap');

afterAll(cleanupSandboxes);

describe('every guard binds', () => {
  it('has guards to check', () => {
    expect(selected.length).toBeGreaterThan(0);
  });

  it.each(selected)('$id passes against reality', (guard: Guard) => {
    // The floor: a mutation proving a guard fails is worth nothing if the guard
    // fails on the unmutated world too.
    expect(guard.probe(), `${guard.id} does not hold today: ${guard.binds}`).toBe(true);
  });

  it.each(selected)('$id can say how it would fail', (guard: Guard) => {
    // A guard that cannot state a single violation is a finding, not a pass.
    expect(guard.violations.length, `${guard.id} declares no way to violate it`).toBeGreaterThan(0);
  });

  it.each(
    selected.flatMap((guard) =>
      guard.violations.map((violation) => ({ id: guard.id, violation, guard })),
    ),
  )('$id fails when $violation', ({ guard, violation }) => {
    expect(
      guard.probe(violation),
      `${guard.id} still passes when ${violation} — it is not guarding ${guard.binds}`,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Discovery: the next guard added has to arrive here too
// ---------------------------------------------------------------------------

/**
 * Files a ratchet could plausibly live in. Everything else is application code:
 * `MAX_TRACK_BODY_BYTES` is a runtime limit the server enforces on requests, not
 * a CI ceiling somebody has to keep true.
 */
const GUARDABLE = /(\.test\.ts|\.guard\.ts|bench[^/]*\.ts)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'fixtures',
  '.vite',
  'brand',
  '.claude',
]);

/**
 * A named numeric ceiling — the shape every budget in this repo takes. Deliberately
 * a heuristic over a list: a list would be one more thing to remember.
 */
const BUDGET_CONSTANT =
  /\b[A-Z][A-Z0-9_]*(MAX|MIN|BUDGET|LIMIT|BYTES|THRESHOLD)[A-Z0-9_]*\s*=\s*[0-9_]+|maxGzipBytes:\s*[0-9_]+/;

/**
 * The tag a guard declares itself with, on its own JSDoc line. Anchored that
 * tightly on purpose: a looser pattern reads the prose of this very file — which
 * discusses the tag — and invents guards named "is" and "tag".
 */
const GUARD_TAG = /^[ \t]*\*[ \t]*@guard[ \t]+([a-z0-9-]+)[ \t]*$/gm;

interface Scanned {
  path: string;
  source: string;
}

function scan(dir: string): Scanned[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return scan(path);
    if (!name.endsWith('.ts')) return [];
    return [{ path: relative(REPO, path), source: readFileSync(path, 'utf8') }];
  });
}

const FILES = scan(REPO);

/**
 * Constants that look like budgets but are protocol or corpus facts, not ceilings
 * anybody has to keep true. Each needs a reason; an empty entry is not allowed.
 */
const NOT_A_BUDGET: Readonly<Record<string, string>> = {
  'apps/server/test/matomo-corpus.test.ts':
    'GIF_BYTES is the size of the tracking GIF, fixed by the format',
  'apps/server/test/replay/generate.ts':
    'MAX_PINGS_PER_STEP shapes the synthetic corpus; it bounds nothing in CI',
};

describe('the inventory cannot fall behind the repo', () => {
  it('reads a real tree', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('registers exactly the files that declare themselves guards', () => {
    const tagged = new Map<string, string>();
    for (const file of FILES) {
      for (const [, id] of file.source.matchAll(GUARD_TAG)) tagged.set(id as string, file.path);
    }
    const registered = new Map(GUARDS.map((guard) => [guard.id, guard.source]));
    expect(
      [...tagged.keys()].sort(),
      'a file tagged @guard is not in GUARDS (or vice versa) — every guard needs a mutation that proves it binds',
    ).toEqual([...registered.keys()].sort());
    for (const [id, path] of tagged) {
      expect(registered.get(id), `guard '${id}' points at the wrong file`).toBe(path);
    }
  });

  it('leaves no budget constant unguarded', () => {
    const unguarded = FILES.filter(
      (file) =>
        GUARDABLE.test(file.path) &&
        BUDGET_CONSTANT.test(file.source) &&
        !new RegExp(GUARD_TAG.source, 'm').test(file.source) &&
        NOT_A_BUDGET[file.path] === undefined,
    ).map((file) => file.path);
    expect(
      unguarded,
      'these declare a ceiling but no @guard tag — register the guard in test/guards/inventory.ts, or explain the constant in NOT_A_BUDGET',
    ).toEqual([]);
  });

  it('keeps every exemption explained', () => {
    for (const [path, reason] of Object.entries(NOT_A_BUDGET)) {
      expect(
        FILES.map((file) => file.path),
        `${path} is exempted but no longer exists`,
      ).toContain(path);
      expect(reason.length, `${path} is exempted without a reason`).toBeGreaterThan(20);
    }
  });
});
