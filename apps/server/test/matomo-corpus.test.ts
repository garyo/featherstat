import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Hit, type HitContext, HitSchema } from '@analytics/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index.ts';

interface CorpusCase {
  name: string;
  method: 'GET' | 'POST';
  path?: string;
  query?: string;
  body?: string;
  contentType?: string;
  expectStatus: number;
  expectHits: Hit[];
}

const CORPUS_DIR = fileURLToPath(new URL('./fixtures/matomo/', import.meta.url));
/** Bytes of the 1×1 transparent tracking GIF. */
const GIF_BYTES = 42;

const files = readdirSync(CORPUS_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort();

describe('matomo golden corpus', () => {
  it('has fixtures', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const testCase = JSON.parse(readFileSync(CORPUS_DIR + file, 'utf8')) as CorpusCase;

    it(`${file}: ${testCase.name}`, async () => {
      const expectHits = HitSchema.array().parse(testCase.expectHits);
      const hits: Hit[] = [];
      const contexts: HitContext[] = [];
      const app = createApp((batch, ctx) => {
        hits.push(...batch);
        contexts.push(ctx);
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
