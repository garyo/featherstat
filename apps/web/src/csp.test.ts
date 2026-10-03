import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The server sends `script-src 'self'` (apps/server/src/auth/app.ts), so the
 * browser refuses any inline script in the page — silently, bar a console line.
 */
describe('index.html', () => {
  it('carries no inline script', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
      ([, attrs, body]) => !/\bsrc=/.test(attrs ?? '') || (body ?? '').trim() !== '',
    );
    expect(inline).toEqual([]);
  });
});
