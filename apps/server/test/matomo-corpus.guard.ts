import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hit } from '@featherstat/shared';

/**
 * The golden Matomo corpus, as a ratchet rather than as a directory.
 *
 * @guard matomo-corpus
 *
 * CLAUDE.md invariant 6 says the corpus only gains cases — but nothing enforced
 * it, and "never delete a fixture" is exactly the kind of rule that survives
 * until the afternoon someone deletes a fixture to make a change pass. The floor
 * below is the enforcement: it is raised when cases are added and can never be
 * lowered without saying so out loud, in a diff, on purpose.
 *
 * `readCorpus` also fails on a fixture that has stopped being a test — an empty
 * file, or one with no expectation in it. A corpus of ten files that assert
 * nothing counts as ten files to a naive floor.
 */

export const CORPUS_DIR = fileURLToPath(new URL('./fixtures/matomo/', import.meta.url));

/** Raised when cases are added; never lowered (invariant 6). 18 cases as of 2026-07-30. */
export const MIN_CORPUS_CASES = 18;

export interface CorpusCase {
  name: string;
  method: 'GET' | 'POST';
  path?: string;
  query?: string;
  body?: string;
  contentType?: string;
  expectStatus: number;
  expectHits: Hit[];
}

export interface CorpusEntry {
  file: string;
  testCase: CorpusCase;
}

export function readCorpus(dir: string = CORPUS_DIR): CorpusEntry[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      testCase: JSON.parse(readFileSync(dir + file, 'utf8')) as CorpusCase,
    }));
}

/** Every way the corpus could have stopped being the compatibility contract it claims to be. */
export function corpusBreaches(dir: string = CORPUS_DIR): string[] {
  const breaches: string[] = [];
  const entries = readCorpus(dir);
  if (entries.length < MIN_CORPUS_CASES) {
    breaches.push(
      `${entries.length} fixtures, below the floor of ${MIN_CORPUS_CASES} — a golden corpus only gains cases (CLAUDE.md invariant 6)`,
    );
  }
  for (const { file, testCase } of entries) {
    if (typeof testCase.name !== 'string' || testCase.name === '') {
      breaches.push(`${file} has no name`);
    }
    if (typeof testCase.expectStatus !== 'number') {
      breaches.push(`${file} expects no status`);
    }
    if (!Array.isArray(testCase.expectHits)) {
      breaches.push(`${file} expects no hits — a fixture that asserts nothing is not a case`);
    }
  }
  return breaches;
}
