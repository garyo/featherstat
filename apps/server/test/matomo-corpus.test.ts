import { type Hit, type HitContext, HitSchema } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index.ts';
import {
  type CorpusCase,
  corpusBreaches,
  MIN_CORPUS_CASES,
  readCorpus,
} from './matomo-corpus.guard.ts';

/** Bytes of the 1×1 transparent tracking GIF. */
const GIF_BYTES = 42;

const corpus = readCorpus();

describe('matomo golden corpus', () => {
  it(`keeps at least ${MIN_CORPUS_CASES} fixtures, each of which asserts something`, () => {
    // The ratchet on the corpus itself (CLAUDE.md invariant 6). `test/guards`
    // deletes a fixture from a copy and checks this says so.
    expect(corpusBreaches()).toEqual([]);
  });

  for (const { file, testCase } of corpus) {
    it(`${file}: ${testCase.name}`, async () => {
      const expectHits = HitSchema.array().parse(testCase.expectHits);
      const hits: Hit[] = [];
      const contexts: HitContext[] = [];
      const app = createApp({
        sink: (batch, ctx) => {
          hits.push(...batch);
          contexts.push(ctx);
        },
      });

      const before = Date.now();
      const res = await app.request(requestPath(testCase), requestInit(testCase));

      expect(res.status).toBe(testCase.expectStatus);
      expect(hits).toEqual(expectHits);

      if (res.status === 200) {
        expect(res.headers.get('content-type')).toBe('image/gif');
        const gif = new Uint8Array(await res.arrayBuffer());
        expect(gif.byteLength).toBe(GIF_BYTES);
        expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
      } else {
        expect(await res.text()).toBe('');
      }
      for (const ctx of contexts) {
        expect(ctx.receivedAt).toBeGreaterThanOrEqual(before);
        expect(ctx.receivedAt).toBeLessThanOrEqual(Date.now());
      }
    });
  }
});

function requestPath(testCase: CorpusCase): string {
  const path = testCase.path ?? '/matomo.php';
  return testCase.query ? `${path}?${testCase.query}` : path;
}

function requestInit(testCase: CorpusCase): RequestInit {
  if (testCase.method !== 'POST') return { method: testCase.method };
  return {
    method: 'POST',
    body: testCase.body,
    headers: testCase.contentType ? { 'content-type': testCase.contentType } : undefined,
  };
}
