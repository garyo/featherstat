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

/** DEFAULT_VIEW_STATE with overrides — keeps cases readable as the shape grows. */
const at = (patch: Partial<ViewState>): ViewState => ({ ...DEFAULT_VIEW_STATE, ...patch });

describe('view state parsing', () => {
  it('opens on the overview when the URL says nothing', () => {
    expect(parseViewState('/')).toEqual(DEFAULT_VIEW_STATE);
    expect(parseViewState('http://localhost:5173/')).toEqual(DEFAULT_VIEW_STATE);
  });

  it('reads site, range, view and filters', () => {
    expect(parseViewState('/?site=4&range=7d')).toEqual({
      ...DEFAULT_VIEW_STATE,
      site: 4,
      range: '7d',
    });
    expect(parseViewState('/?site=all&range=mtd')).toEqual({
      ...DEFAULT_VIEW_STATE,
      range: 'mtd',
    });
    expect(parseViewState('/?view=realtime&f=country:eq:US')).toEqual({
      ...DEFAULT_VIEW_STATE,
      view: 'realtime',
      filters: [{ dim: 'country', op: 'eq', value: 'US' }],
    });
    expect(parseViewState('/?view=settings').view).toBe('settings');
  });

  it('falls back to the default rather than failing on a mangled link', () => {
    for (const site of ['0', '-1', '2.5', 'four', '']) {
      expect(parseViewState(`/?site=${site}`).site).toBe(DEFAULT_VIEW_STATE.site);
    }
    expect(parseViewState('/?range=fortnight').range).toBe(DEFAULT_VIEW_STATE.range);
    expect(parseViewState('/?view=globe').view).toBe('dash');
    expect(parseViewState('/?f=broken').filters).toEqual([]);
  });
});

describe('view state serialization', () => {
  it('round-trips every reachable state', () => {
    for (const site of SITES) {
      for (const range of RANGE_PRESETS) {
        for (const view of ['dash', 'realtime', 'settings'] as const) {
          const state: ViewState = { site, range, view, filters: [] };
          expect(parseViewState(applyViewState(state, '/'))).toEqual(state);
        }
      }
    }
  });

  it('writes only what differs from the default', () => {
    expect(applyViewState(DEFAULT_VIEW_STATE, '/dash?site=4&range=7d&view=realtime')).toBe('/dash');
    expect(applyViewState(at({ site: 4 }), '/')).toBe('/?site=4');
    expect(applyViewState(at({ range: '7d' }), '/')).toBe('/?range=7d');
    expect(applyViewState(at({ view: 'realtime' }), '/')).toBe('/?view=realtime');
  });

  it('keeps the path, unrelated params and the hash', () => {
    const href = 'http://localhost:5173/dash?keep=1#pages';
    expect(applyViewState(at({ site: 4, range: '7d' }), href)).toBe(
      '/dash?keep=1&site=4&range=7d#pages',
    );
  });

  it('compares states by value', () => {
    expect(sameViewState(at({ site: 4, range: '7d' }), at({ site: 4, range: '7d' }))).toBe(true);
    expect(sameViewState(at({ site: 4 }), at({ site: 4, range: '7d' }))).toBe(false);
    expect(sameViewState(at({ site: 4 }), at({ site: 'all' }))).toBe(false);
    expect(sameViewState(at({ view: 'realtime' }), at({}))).toBe(false);
    const chip = { dim: 'country', op: 'eq', value: 'US' } as const;
    expect(sameViewState(at({ filters: [chip] }), at({ filters: [chip] }))).toBe(true);
    expect(sameViewState(at({ filters: [chip] }), at({}))).toBe(false);
  });
});

describe('range presets', () => {
  it('offers every preset the query API accepts, in display order', () => {
    expect(RANGE_PRESETS).toEqual(['today', '7d', '30d', '90d', 'mtd']);
    for (const preset of RANGE_PRESETS) expect(RANGE_LABELS[preset]).toBeTruthy();
  });
});
