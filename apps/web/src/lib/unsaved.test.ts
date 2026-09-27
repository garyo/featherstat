import { describe, expect, it, vi } from 'vitest';
import { confirmDiscard, edited } from './unsaved.ts';

describe('edited', () => {
  it('tells a changed draft from an untouched one, and an undone edit from a kept one', () => {
    const opened = { name: 'Signups', rows: [{ dim: 'path', value: '/thanks' }] };
    expect(edited(JSON.parse(JSON.stringify(opened)), opened)).toBe(false);
    expect(edited({ ...opened, name: 'Sign-ups' }, opened)).toBe(true);
    expect(edited({ ...opened, name: 'Signups' }, opened)).toBe(false);
  });

  it('reads a draft that only reordered its keys as no edit', () => {
    expect(edited({ b: 1, a: [{ y: 2, x: 1 }] }, { a: [{ x: 1, y: 2 }], b: 1 })).toBe(false);
  });
});

/**
 * The decision every move makes before it discards a draft: a changed draft is
 * confirmed away, never silently discarded — and never asked about when there
 * is no change to lose.
 */
describe('confirmDiscard', () => {
  it('lets a move through without asking when the draft holds no change', () => {
    const ask = vi.fn(() => false);
    expect(confirmDiscard(false, 'Content', ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks — naming what is being edited — and relays the answer', () => {
    expect(
      confirmDiscard(true, 'Content', (message) => {
        expect(message).toBe('Discard unsaved changes to Content?');
        return true;
      }),
    ).toBe(true);
    expect(confirmDiscard(true, 'Content', () => false)).toBe(false);
  });
});
