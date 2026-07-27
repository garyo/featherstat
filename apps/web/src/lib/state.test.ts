import { describe, expect, it } from 'vitest';
import {
  applyViewState,
  DEFAULT_VIEW_STATE,
  parseViewState,
  RANGE_LABELS,
  RANGE_PRESETS,
  type SiteScope,
  sameViewState,
  type ViewState,
} from './state.ts';

const SITES: SiteScope[] = ['all', 1, 4, 6];

describe('view state parsing', () => {
  it('opens on the overview when the URL says nothing', () => {
    expect(parseViewState('/')).toEqual(DEFAULT_VIEW_STATE);
    expect(parseViewState('http://localhost:5173/')).toEqual(DEFAULT_VIEW_STATE);
  });

  it('reads site and range', () => {
    expect(parseViewState('/?site=4&range=7d')).toEqual({ site: 4, range: '7d' });
    expect(parseViewState('/?site=all&range=mtd')).toEqual({ site: 'all', range: 'mtd' });
  });

  it('falls back to the default rather than failing on a mangled link', () => {
    for (const site of ['0', '-1', '2.5', 'four', '']) {
      expect(parseViewState(`/?site=${site}`).site).toBe(DEFAULT_VIEW_STATE.site);
    }
    expect(parseViewState('/?range=fortnight').range).toBe(DEFAULT_VIEW_STATE.range);
  });
});

describe('view state serialization', () => {
  it('round-trips every reachable state', () => {
    for (const site of SITES) {
      for (const range of RANGE_PRESETS) {
        const state: ViewState = { site, range };
        expect(parseViewState(applyViewState(state, '/'))).toEqual(state);
      }
    }
  });

  it('writes only what differs from the default', () => {
    expect(applyViewState(DEFAULT_VIEW_STATE, '/dash?site=4&range=7d')).toBe('/dash');
    expect(applyViewState({ site: 4, range: '30d' }, '/')).toBe('/?site=4');
    expect(applyViewState({ site: 'all', range: '7d' }, '/')).toBe('/?range=7d');
  });

  it('keeps the path, unrelated params and the hash', () => {
    const href = 'http://localhost:5173/dash?keep=1#pages';
    expect(applyViewState({ site: 4, range: '7d' }, href)).toBe(
      '/dash?keep=1&site=4&range=7d#pages',
    );
  });

  it('compares states by value', () => {
    expect(sameViewState({ site: 4, range: '7d' }, { site: 4, range: '7d' })).toBe(true);
    expect(sameViewState({ site: 4, range: '7d' }, { site: 4, range: '30d' })).toBe(false);
    expect(sameViewState({ site: 4, range: '7d' }, { site: 'all', range: '7d' })).toBe(false);
  });
});

describe('range presets', () => {
  it('offers every preset the query API accepts, in display order', () => {
    expect(RANGE_PRESETS).toEqual(['today', '7d', '30d', '90d', 'mtd']);
    for (const preset of RANGE_PRESETS) expect(RANGE_LABELS[preset]).toBeTruthy();
  });
});
