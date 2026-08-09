// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { whenActivated } from './prerender.ts';

/** happy-dom does not prerender, so the flag the guard reads is installed by hand. */
function speculating(on: boolean): void {
  Object.defineProperty(document, 'prerendering', { value: on, configurable: true });
}

/** The visitor follows the link: the flag clears, then the event announces it. */
function arrive(): void {
  speculating(false);
  document.dispatchEvent(new Event('prerenderingchange'));
}

afterEach(() => {
  Reflect.deleteProperty(document, 'prerendering');
});

describe('whenActivated (prerender.ts)', () => {
  it('runs straight away in a document nobody speculated on', () => {
    const run = vi.fn();
    expect(whenActivated(run)).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('holds the work while the document is only being speculated on', () => {
    speculating(true);
    const run = vi.fn();
    whenActivated(run);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs it when the visitor actually arrives', () => {
    speculating(true);
    const run = vi.fn();
    whenActivated(run);
    arrive();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs it once however many times activation is announced', () => {
    speculating(true);
    const run = vi.fn();
    whenActivated(run);
    arrive();
    document.dispatchEvent(new Event('prerenderingchange'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The whole point: a speculated page the visitor never chose costs nothing.
  it('never runs it for a prerender that is discarded before activation', () => {
    speculating(true);
    const run = vi.fn();
    whenActivated(run)?.();
    arrive();
    expect(run).not.toHaveBeenCalled();
  });
});
