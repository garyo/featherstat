import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadChunk, onChunkFailure } from './chunks.ts';

/**
 * The defect this exists for: a tab open across a deploy asks for a chunk hash
 * the server has dropped, the dynamic import rejects, and the click does
 * nothing visible. A rejection must reach the shell, not just the console.
 */
describe('loadChunk', () => {
  afterEach(() => onChunkFailure(() => {}));

  it('passes the chunk through and reports nothing while loads succeed', async () => {
    const failed = vi.fn();
    onChunkFailure(failed);

    await expect(loadChunk(async () => ({ Editor: 'component' }))).resolves.toEqual({
      Editor: 'component',
    });
    expect(failed).not.toHaveBeenCalled();
  });

  it('answers undefined and reports, so the caller renders nothing and the shell speaks', async () => {
    const failed = vi.fn();
    onChunkFailure(failed);

    await expect(
      loadChunk(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))),
    ).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledOnce();
  });

  it('reports every failure, so a chunk that fails first is not the only one heard', async () => {
    const failed = vi.fn();
    onChunkFailure(failed);

    await loadChunk(() => Promise.reject(new Error('404')));
    await loadChunk(() => Promise.reject(new Error('404')));
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it('swallows the rejection either way — a dead chunk must never crash the page', async () => {
    onChunkFailure(() => {});
    await expect(loadChunk(() => Promise.reject(new Error('404')))).resolves.toBeUndefined();
  });
});
