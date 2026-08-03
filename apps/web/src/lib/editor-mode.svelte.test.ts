import { describe, expect, it, vi } from 'vitest';
import { confirmDashboardSwitch } from './editor-mode.svelte.ts';

/**
 * The decision the header's pickers make before a scope or dashboard switch
 * lands: an open editor draft is confirmed away, never silently discarded —
 * and never asked about when there is no draft to lose.
 */
describe('confirmDashboardSwitch', () => {
  it('lets a switch through without asking when nothing is being edited', () => {
    const ask = vi.fn(() => false);
    expect(confirmDashboardSwitch(false, 'Content', ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks — naming the dashboard being edited — and relays the answer', () => {
    expect(
      confirmDashboardSwitch(true, 'Content', (message) => {
        expect(message).toBe('Discard unsaved changes to Content?');
        return true;
      }),
    ).toBe(true);
    expect(confirmDashboardSwitch(true, 'Content', () => false)).toBe(false);
  });

  it('still reads as a sentence when the selection has no name yet', () => {
    const ask = vi.fn((message: string) => {
      expect(message).toBe('Discard unsaved changes to this dashboard?');
      return true;
    });
    expect(confirmDashboardSwitch(true, undefined, ask)).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
  });
});
