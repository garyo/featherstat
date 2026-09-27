import {
  applyViewState,
  parseViewState,
  sameViewState,
  type ViewState,
  type ViewStatePatch,
} from './state.ts';

/**
 * The URL is the store: reads come from it, writes push to it, and back/forward
 * are just another writer (docs/05 — every view state is linkable).
 *
 * A history move cannot be cancelled, only undone: when `admit` refuses one
 * (an unsaved editor draft the reader chose to keep), the state stays and its
 * URL is pushed back over the one the browser moved to.
 */
export interface ViewStateStore {
  readonly current: ViewState;
  update(patch: ViewStatePatch): void;
  destroy(): void;
}

export function createViewState(
  win: Window = window,
  admit: (from: ViewState, to: ViewState) => boolean = () => true,
): ViewStateStore {
  let current = $state(parseViewState(win.location.href));

  const sync = (): void => {
    const next = parseViewState(win.location.href);
    if (admit(current, next)) current = next;
    else win.history.pushState(null, '', applyViewState(current, win.location.href));
  };
  win.addEventListener('popstate', sync);

  return {
    get current(): ViewState {
      return current;
    },
    update(patch: ViewStatePatch): void {
      const next = { ...current, ...patch };
      if (sameViewState(next, current)) return;
      current = next;
      win.history.pushState(null, '', applyViewState(next, win.location.href));
    },
    destroy(): void {
      win.removeEventListener('popstate', sync);
    },
  };
}
