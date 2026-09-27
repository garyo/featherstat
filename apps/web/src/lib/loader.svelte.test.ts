import { describe, expect, it, vi } from 'vitest';
import { deferred } from './fake-admin.ts';
import { createLoader } from './loader.svelte.ts';

/**
 * The sequencing a settings list relies on. Outside the Svelte compiler
 * `$state(v)` is an identity call, which is all the ordering needs.
 */
vi.stubGlobal('$state', <T>(value: T): T => value);

describe('createLoader', () => {
  it('never lets an older site’s answer land under a newer site', async () => {
    const answers = new Map([
      [1, deferred<string[]>()],
      [2, deferred<string[]>()],
    ]);
    const goals = createLoader((site: number) => answers.get(site)?.promise ?? Promise.reject());

    const first = goals.load(1);
    const second = goals.load(2);
    answers.get(2)?.resolve(['site 2 goal']);
    await second;
    answers.get(1)?.resolve(['site 1 goal']);
    await expect(first).resolves.toBeUndefined();

    expect(goals.value).toEqual(['site 2 goal']);
  });

  it('blanks the old answer when the key changes, keeps it on a same-key refresh', async () => {
    const refresh = deferred<string>();
    const reads = [Promise.resolve('a'), refresh.promise, deferred<string>().promise];
    const loader = createLoader((_site: number) => reads.shift() ?? Promise.reject());

    await loader.load(1);
    const again = loader.reload();
    expect(loader.value).toBe('a');
    refresh.resolve('a2');
    await again;
    expect(loader.value).toBe('a2');

    void loader.load(2);
    expect(loader.value).toBeUndefined();
  });

  it('forgets a failure on the next call, so Retry can succeed', async () => {
    let fail = true;
    const loader = createLoader(async () => {
      if (fail) throw new Error('offline');
      return ['token'];
    });

    await loader.load();
    expect(loader.failed).toBe(true);

    fail = false;
    const retry = loader.reload();
    expect(loader.failed).toBe(false);
    await retry;
    expect(loader.value).toEqual(['token']);
  });

  it('adopts a mutation’s answer over a read still in flight, and tells the form', async () => {
    const slow = deferred<string>();
    const onload = vi.fn();
    const loader = createLoader(() => slow.promise, { onload });

    const reading = loader.load();
    loader.set('saved');
    slow.resolve('stale');
    await reading;

    expect(loader.value).toBe('saved');
    expect(onload.mock.calls).toEqual([['saved']]);
  });
});
