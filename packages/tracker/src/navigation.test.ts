import { describe, expect, it } from 'vitest';
import { isNewView } from './navigation.ts';

const PAGE = 'https://deep-timeline.org/era/cambrian';

describe('isNewView', () => {
  it('never counts a fragment', () => {
    for (const change of ['push', 'replace', 'pop'] as const) {
      expect(isNewView(PAGE, `${PAGE}#fauna`, change), change).toBe(false);
      expect(isNewView(`${PAGE}#fauna`, `${PAGE}#flora`, change), change).toBe(false);
    }
  });

  it('counts a path change however it happened', () => {
    for (const change of ['push', 'replace', 'pop'] as const) {
      expect(isNewView(PAGE, 'https://deep-timeline.org/era/permian', change), change).toBe(true);
    }
  });

  it('counts a query change pushed or popped, not replaced', () => {
    expect(isNewView(PAGE, `${PAGE}?page=2`, 'push')).toBe(true);
    expect(isNewView(PAGE, `${PAGE}?page=2`, 'pop')).toBe(true);
    expect(isNewView(`${PAGE}?q=ow`, `${PAGE}?q=owl`, 'replace')).toBe(false);
  });

  it('counts nothing for no change, and never throws on a malformed URL', () => {
    expect(isNewView(PAGE, PAGE, 'push')).toBe(false);
    expect(isNewView('', PAGE, 'replace')).toBe(true);
    expect(isNewView('not a url', 'not a url', 'pop')).toBe(false);
  });
});
