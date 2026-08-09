/**
 * A page view waits for the visitor to actually arrive, shared by both trackers.
 *
 * Speculation rules PRERENDER a likely-next page: the browser fetches it, parses
 * it and runs its scripts — this one included — before the visitor has clicked
 * anything, and discards the whole document if they never do. Announcing the view
 * at parse time books a visit nobody made, and it is a visit the reader cannot
 * argue with later, because there is no trace of the click that did not happen.
 *
 * `repeat.ts` cannot cover this the way it covers a double-firing SPA router: a
 * prerendered document is its own realm with its own copy of the tracker, so two
 * of them are two first views, each with its own memory of having seen nothing.
 * The guard has to be the arrival itself.
 *
 * `document.prerendering` is true only while speculating, and `prerenderingchange`
 * fires once, at activation. Neither exists in a browser that does not prerender,
 * so every ordinary document takes the immediate path for one property read.
 */
export function whenActivated(run: () => void): (() => void) | undefined {
  if (!document.prerendering) {
    run();
    return undefined;
  }
  const onActivate = (): void => {
    // Removed first: activation is announced once, but the work must not repeat
    // even if a browser is generous with the event.
    document.removeEventListener('prerenderingchange', onActivate);
    run();
  };
  document.addEventListener('prerenderingchange', onActivate);
  return (): void => document.removeEventListener('prerenderingchange', onActivate);
}
