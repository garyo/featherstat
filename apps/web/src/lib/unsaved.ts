import { canonicalJson } from './api.ts';

/**
 * "Has unsaved changes", defined once for every surface that holds a draft —
 * the dashboard editor and each Settings form — and the one question asked
 * before a move discards one.
 */

/**
 * Whether a draft differs from what it was opened on. Compared as the canonical
 * JSON each would send, so an edit typed and then undone reads as no edit at
 * all, and neither does a draft that merely rebuilt its keys in another order.
 */
export function edited(draft: unknown, opened: unknown): boolean {
  return canonicalJson(draft) !== canonicalJson(opened);
}

/**
 * Whether a move that would discard `what`'s draft may proceed — asked only
 * when the draft holds a change to lose. Pure so the decision is testable; the
 * caller supplies `window.confirm`.
 */
export function confirmDiscard(
  dirty: boolean,
  what: string,
  ask: (message: string) => boolean,
): boolean {
  return !dirty || ask(`Discard unsaved changes to ${what}?`);
}
