import { afterEach, describe, expect, it } from 'vitest';
import { createViewState, type ViewStateStore } from './state.svelte.ts';
import { discardsDraft } from './state.ts';

/**
 * Back/forward is a writer of the view state like any control — and, like any
 * control, may be refused when it would take an unsaved editor draft away.
 * History cannot cancel a move, so a refusal pushes the kept state's URL back.
 */

const stores: ViewStateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.destroy();
  window.history.replaceState(null, '', '/');
});

/** Simulates the browser having moved to `href` and told the page. */
function popTo(href: string): void {
  window.history.replaceState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

describe('createViewState', () => {
  it('follows back/forward when nothing objects', () => {
    window.history.replaceState(null, '', '/?site=3&dash=7');
    const view = createViewState(window);
    stores.push(view);
    popTo('/?site=1&dash=1');
    expect(view.current.site).toBe(1);
    expect(view.current.dash).toBe(1);
  });

  it('stays on the edited dashboard, URL and all, when the move is refused', () => {
    window.history.replaceState(null, '', '/?site=3&dash=7');
    const asked: Array<[number | string, number | string | undefined]> = [];
    const view = createViewState(window, (from, to) => {
      asked.push([to.site, to.dash]);
      return !discardsDraft(from, to);
    });
    stores.push(view);

    popTo('/?site=1&dash=1');
    expect(asked).toEqual([[1, 1]]);
    expect(view.current.site).toBe(3);
    expect(view.current.dash).toBe(7);
    expect(new URL(window.location.href).search).toBe('?site=3&dash=7');

    // A range move keeps the dashboard, so it is admitted.
    popTo('/?site=3&dash=7&range=7d');
    expect(view.current.range).toBe('7d');
  });
});
