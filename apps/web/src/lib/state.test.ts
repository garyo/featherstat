import { type QueryRequest, RangeSchema } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  applyViewState,
  compareNote,
  compareParam,
  DEFAULT_VIEW_STATE,
  discardsDraft,
  failureNote,
  formatDayRange,
  heldRange,
  localDayKey,
  parseDashRef,
  parseDetailRef,
  parseViewState,
  RANGE_LABELS,
  RANGE_PRESETS,
  rangeDays,
  rangeLabel,
  rangeQualifier,
  resolveNav,
  type SiteScope,
  sameViewState,
  toRange,
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
    expect(parseViewState('/?view=journeys').view).toBe('journeys');
  });

  it('falls back to the default rather than failing on a mangled link', () => {
    for (const site of ['0', '-1', '2.5', 'four', '']) {
      expect(parseViewState(`/?site=${site}`).site).toBe(DEFAULT_VIEW_STATE.site);
    }
    expect(parseViewState('/?range=fortnight').range).toBe(DEFAULT_VIEW_STATE.range);
    expect(parseViewState('/?view=globe').view).toBe('dash');
    expect(parseViewState('/?f=broken').filters).toEqual([]);
  });

  it('reads an explicit date range, refusing impossible or reversed dates', () => {
    expect(parseViewState('/?range=2026-06-01..2026-06-30').range).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
    // Reversed, non-calendar and half-formed all fall back — a bad link opens a dashboard.
    for (const raw of [
      '2026-06-30..2026-06-01',
      '2026-02-30..2026-03-01',
      '2026-06-01..',
      '2026-06-01',
    ]) {
      expect(parseViewState(`/?range=${raw}`).range).toBe(DEFAULT_VIEW_STATE.range);
    }
  });

  it('reads the compare mode, defaulting to previous', () => {
    expect(parseViewState('/').cmp).toBe('previous');
    expect(parseViewState('/?cmp=year').cmp).toBe('year');
    expect(parseViewState('/?cmp=off').cmp).toBe('off');
    expect(parseViewState('/?cmp=2026-05-01..2026-05-14').cmp).toEqual({
      from: '2026-05-01',
      to: '2026-05-14',
    });
    expect(parseViewState('/?cmp=sideways').cmp).toBe('previous');
  });

  it('reads the library selection: a row id or a t:<template> ref', () => {
    expect(parseViewState('/').dash).toBeUndefined();
    expect(parseViewState('/?dash=7').dash).toBe(7);
    expect(parseViewState('/?dash=t:content').dash).toBe('t:content');
    for (const raw of ['0', '-3', 'x', 't:', 't:UPPER']) {
      expect(parseViewState(`/?dash=${raw}`).dash, raw).toBeUndefined();
    }
    expect(parseDashRef('t:all-sites')).toBe('t:all-sites');
  });
});

describe('view state serialization', () => {
  it('round-trips every reachable state', () => {
    for (const site of SITES) {
      for (const range of RANGE_PRESETS) {
        for (const view of ['dash', 'journeys', 'realtime', 'settings'] as const) {
          const state: ViewState = at({ site, range, view });
          expect(parseViewState(applyViewState(state, '/'))).toEqual(state);
        }
      }
    }
  });

  it('round-trips the new axes: custom range, compare mode, library selection', () => {
    const states: ViewState[] = [
      at({ range: { from: '2026-06-01', to: '2026-06-30' } }),
      at({ cmp: 'off' }),
      at({ cmp: 'year' }),
      at({ cmp: { from: '2026-05-01', to: '2026-05-14' } }),
      at({ dash: 7 }),
      at({ dash: 't:content' }),
      at({
        range: { from: '2026-06-01', to: '2026-06-01' },
        cmp: { from: '2026-05-01', to: '2026-05-31' },
        dash: 't:acquisition',
        site: 4,
      }),
    ];
    for (const state of states) {
      expect(parseViewState(applyViewState(state, '/'))).toEqual(state);
    }
  });

  it('writes only what differs from the default', () => {
    expect(
      applyViewState(DEFAULT_VIEW_STATE, '/dash?site=4&range=7d&view=realtime&cmp=off&dash=3'),
    ).toBe('/dash');
    expect(applyViewState(at({ site: 4 }), '/')).toBe('/?site=4');
    expect(applyViewState(at({ range: '7d' }), '/')).toBe('/?range=7d');
    expect(applyViewState(at({ view: 'realtime' }), '/')).toBe('/?view=realtime');
    expect(applyViewState(at({ cmp: 'off' }), '/')).toBe('/?cmp=off');
    expect(applyViewState(at({ dash: 't:content' }), '/')).toBe('/?dash=t%3Acontent');
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
    // The new axes compare by value too — a fresh {from,to} object is the same state.
    const june = { from: '2026-06-01', to: '2026-06-30' };
    expect(sameViewState(at({ range: { ...june } }), at({ range: { ...june } }))).toBe(true);
    expect(sameViewState(at({ range: { ...june } }), at({ range: '30d' }))).toBe(false);
    expect(sameViewState(at({ cmp: { ...june } }), at({ cmp: { ...june } }))).toBe(true);
    expect(sameViewState(at({ cmp: 'off' }), at({}))).toBe(false);
    expect(sameViewState(at({ dash: 7 }), at({ dash: 7 }))).toBe(true);
    expect(sameViewState(at({ dash: 7 }), at({ dash: 't:content' }))).toBe(false);
  });
});

describe('range presets', () => {
  it('offers every preset the query API accepts, in display order', () => {
    expect(RANGE_PRESETS).toEqual(['today', '24h', '7d', '30d', '90d', 'mtd']);
    for (const preset of RANGE_PRESETS) {
      expect(RANGE_LABELS[preset]).toBeTruthy();
      // The claim in the name, checked: a label the query API would 400 on is a
      // picker button that blanks the dashboard.
      expect(RangeSchema.safeParse({ preset }).success).toBe(true);
    }
  });
});

describe('range and compare helpers', () => {
  const june: { from: string; to: string } = { from: '2026-06-01', to: '2026-06-30' };

  it('maps the view range onto the query API forms', () => {
    expect(toRange('7d')).toEqual({ preset: '7d' });
    expect(toRange(june)).toBe(june);
    expect(compareParam('previous')).toBe('previous');
    expect(compareParam('year')).toBe('year');
    expect(compareParam('off')).toBeUndefined();
    expect(compareParam(june)).toBe(june);
  });

  it('labels presets from the table and explicit ranges as dates', () => {
    expect(rangeLabel('30d')).toBe('30 days');
    expect(rangeQualifier('30d')).toBe('last 30 days');
    expect(rangeLabel(june)).toBe('Jun 1 – Jun 30, 2026');
    expect(rangeQualifier(june)).toBe('Jun 1 – Jun 30, 2026');
    expect(formatDayRange({ from: '2026-06-01', to: '2026-06-01' })).toBe('Jun 1, 2026');
    expect(formatDayRange({ from: '2025-12-29', to: '2026-01-04' })).toBe(
      'Dec 29, 2025 – Jan 4, 2026',
    );
  });

  it('counts inclusive days', () => {
    expect(rangeDays({ from: '2026-06-01', to: '2026-06-01' })).toBe(1);
    expect(rangeDays(june)).toBe(30);
  });

  it('words the compare note for every mode', () => {
    expect(compareNote('30d', 'previous')).toBe('compared with the previous 30 days');
    expect(compareNote('today', 'previous')).toBe('compared with all of yesterday');
    expect(compareNote(june, 'previous')).toBe('compared with the previous 30 days');
    expect(compareNote({ from: '2026-06-01', to: '2026-06-01' }, 'previous')).toBe(
      'compared with the previous day',
    );
    expect(compareNote('7d', 'year')).toBe('compared with the same period last year');
    expect(compareNote('7d', 'off')).toBeUndefined();
  });

  it('states BOTH lengths when a custom compare window is unequal (docs/04 § 3)', () => {
    const may = { from: '2026-05-01', to: '2026-05-14' };
    expect(compareNote(june, may)).toBe('compared with May 1 – May 14, 2026 (30 days vs 14 days)');
    // Equal lengths need no caveat.
    expect(compareNote({ from: '2026-06-01', to: '2026-06-14' }, may)).toBe(
      'compared with May 1 – May 14, 2026',
    );
    // A preset current window still names the compare dates.
    expect(compareNote('30d', may)).toBe('compared with May 1 – May 14, 2026');
  });
});

describe('resolveNav', () => {
  const at = (site: 'all' | number, view: ViewState['view']): ViewState => ({
    ...DEFAULT_VIEW_STATE,
    site,
    view,
  });

  it('scope changes keep the view', () => {
    expect(resolveNav(at(2, 'realtime'), { site: 3 }, 2)).toEqual({ site: 3 });
    expect(resolveNav(at(2, 'dash'), { site: 'all' }, 2)).toEqual({ site: 'all' });
  });

  it('a scope change drops the library selection — dash names the OLD scope', () => {
    const current = { ...at(2, 'dash'), dash: 7 as const };
    const patch = resolveNav(current, { site: 3 }, 2);
    expect('dash' in patch).toBe(true);
    expect(patch.dash).toBeUndefined();
    // Same scope: the selection survives a view change.
    expect('dash' in resolveNav(current, { view: 'realtime' }, 2)).toBe(false);
  });

  it('view changes keep the scope', () => {
    expect(resolveNav(at(4, 'dash'), { view: 'realtime' }, 4)).toEqual({ view: 'realtime' });
  });

  it('entering Journeys at All coerces the scope to the last-visited site', () => {
    expect(resolveNav(at('all', 'dash'), { view: 'journeys' }, 5)).toEqual({
      view: 'journeys',
      site: 5,
    });
  });

  it('choosing All while on Journeys lands on the overview', () => {
    expect(resolveNav(at(5, 'journeys'), { site: 'all' }, 5)).toEqual({
      site: 'all',
      view: 'dash',
    });
  });
});

describe('what the response on screen answers', () => {
  const request = (range: QueryRequest['range']): QueryRequest => ({
    site: 'all',
    range,
    queries: [{ id: 'kpis', metrics: ['visitors'] }],
  });

  it('is the held request range, preset or explicit, and the pill before one lands', () => {
    expect(heldRange(request({ preset: '7d' }), '30d')).toBe('7d');
    expect(heldRange(request({ from: '2026-06-01', to: '2026-06-30' }), '30d')).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(heldRange(undefined, '30d')).toBe('30d');
  });

  it('says what is shown instead when a change never landed', () => {
    expect(failureNote(true, '7d', '30d')).toBe("Couldn't load last 7 days — showing last 30 days");
    expect(failureNote(false, '30d', '30d')).toBe(
      'Live update failed — showing the last good result',
    );
  });
});

describe('discardsDraft', () => {
  const editing = at({ site: 3, dash: 7 });

  it('is true for every move that takes the edited dashboard away', () => {
    // Back/forward to another site's dashboard is how a stale draft got saved
    // onto the wrong scope: the editor stayed mounted over the new one.
    expect(discardsDraft(editing, at({ site: 1, dash: 1 }))).toBe(true);
    expect(discardsDraft(editing, at({ site: 3, dash: 8 }))).toBe(true);
    expect(discardsDraft(editing, at({ site: 3, dash: 't:overview' }))).toBe(true);
    expect(discardsDraft(editing, { ...editing, view: 'realtime' })).toBe(true);
    expect(discardsDraft(editing, { ...editing, view: 'detail' })).toBe(true);
  });

  it('keeps the draft through moves that keep its dashboard', () => {
    expect(discardsDraft(editing, { ...editing, range: '7d' })).toBe(false);
    expect(discardsDraft(editing, { ...editing, cmp: 'off' })).toBe(false);
    expect(
      discardsDraft(editing, { ...editing, filters: [{ dim: 'country', op: 'eq', value: 'NZ' }] }),
    ).toBe(false);
    expect(
      discardsDraft(editing, { ...editing, pivots: [{ widget: 'pages', dim: 'country' }] }),
    ).toBe(false);
  });

  it('has nothing to discard off the Dashboard view', () => {
    const realtime = at({ site: 3, view: 'realtime' });
    expect(discardsDraft(realtime, at({ site: 1 }))).toBe(false);
  });
});

describe('localDayKey', () => {
  const noon = new Date('2026-07-29T12:00:00Z');

  it('changes when a site rolls into a new local day', () => {
    const before = new Date('2026-07-29T03:59:00Z'); // 23:59 in New York
    const after = new Date('2026-07-29T04:01:00Z'); // 00:01 in New York
    expect(localDayKey(['America/New_York'], before)).not.toBe(
      localDayKey(['America/New_York'], after),
    );
  });

  it('holds steady across an ordinary hour', () => {
    const later = new Date('2026-07-29T13:00:00Z');
    expect(localDayKey(['America/New_York'], noon)).toBe(localDayKey(['America/New_York'], later));
  });

  it('tracks every zone on screen, and is order- and duplicate-insensitive', () => {
    // 12:00 UTC is the 29th in New York and already the 30th in Auckland.
    const key = localDayKey(['America/New_York', 'Pacific/Auckland'], noon);
    expect(key).toContain('2026-07-29');
    expect(key).toContain('2026-07-30');
    expect(localDayKey(['Pacific/Auckland', 'America/New_York'], noon)).toBe(key);
    expect(localDayKey(['America/New_York', 'America/New_York'], noon)).toBe(
      localDayKey(['America/New_York'], noon),
    );
  });
});

describe('detail views in the URL (docs/05 § Detail views)', () => {
  it('reads ?view=detail&d=<dim>:<encoded value>, awkward characters intact', () => {
    const state = parseViewState('/?site=4&view=detail&d=path:%2Fblog%2Fwhy%3A%20colons');
    expect(state.view).toBe('detail');
    expect(state.detail).toEqual({ dim: 'path', value: '/blog/why: colons' });
    expect(parseViewState('/?view=detail&d=ref_domain:news.ycombinator.com').detail).toEqual({
      dim: 'ref_domain',
      value: 'news.ycombinator.com',
    });
  });

  it('opens the dashboard, not an error, when the entity ref is junk', () => {
    // No d, an undrillable dim, an empty value, a stray % — all fall back.
    for (const query of ['view=detail', 'view=detail&d=country:US', 'view=detail&d=path:']) {
      const state = parseViewState(`/?${query}`);
      expect(state.view, query).toBe('dash');
      expect(state.detail, query).toBeUndefined();
    }
    expect(parseDetailRef('path:%ZZ')).toBeUndefined();
  });

  it('ignores a d param on any other view', () => {
    expect(parseViewState('/?view=realtime&d=path:%2Fx').detail).toBeUndefined();
  });

  it('round-trips a detail state', () => {
    const state = at({
      site: 4,
      view: 'detail',
      detail: { dim: 'utm_campaign', value: 'summer:launch' },
    });
    expect(parseViewState(applyViewState(state, '/'))).toEqual(state);
  });

  it('drops the entity from the URL when the view is not detail', () => {
    expect(applyViewState(at({ detail: { dim: 'path', value: '/x' } }), '/')).toBe('/');
  });

  it('naming an entity IS entering its view; leaving forgets it', () => {
    const here = at({ site: 4 });
    const patch = resolveNav(here, { detail: { dim: 'path', value: '/x' } }, 4);
    expect(patch.view).toBe('detail');
    expect(patch.detail).toEqual({ dim: 'path', value: '/x' });
    const on = at({ site: 4, view: 'detail', detail: { dim: 'path', value: '/x' } });
    const away = resolveNav(on, { view: 'realtime' }, 4);
    expect({ ...on, ...away }.detail).toBeUndefined();
  });

  it('is per-site: entering at All coerces to the last-visited site, like Journeys', () => {
    const patch = resolveNav(at({}), { detail: { dim: 'path', value: '/x' } }, 6);
    expect(patch.site).toBe(6);
    const on = at({ site: 6, view: 'detail', detail: { dim: 'path', value: '/x' } });
    expect(resolveNav(on, { site: 'all' }, 6).view).toBe('dash');
  });
});

describe('pivots in the URL (docs/05 § Pivots)', () => {
  it('reads repeatable pv=<widget>:<dim> params, junk dropped, last pick winning', () => {
    expect(parseViewState('/?pv=refs:country&pv=pages:ref_domain').pivots).toEqual([
      { widget: 'refs', dim: 'country' },
      { widget: 'pages', dim: 'ref_domain' },
    ]);
    expect(parseViewState('/?pv=refs:country&pv=refs:path').pivots).toEqual([
      { widget: 'refs', dim: 'path' },
    ]);
    expect(parseViewState('/?pv=refs:nope&pv=refs&pv=:country').pivots).toEqual([]);
    // A widget id may itself carry a ':' — the dim anchors from the right.
    expect(parseViewState('/?pv=a:b:country').pivots).toEqual([{ widget: 'a:b', dim: 'country' }]);
  });

  it('round-trips a pivoted state', () => {
    const state = at({ site: 4, pivots: [{ widget: 'refs', dim: 'country' }] });
    expect(parseViewState(applyViewState(state, '/'))).toEqual(state);
  });

  it('drops the overlay when the scope or the library selection moves', () => {
    const pivoted = at({ site: 4, pivots: [{ widget: 'refs', dim: 'country' }] });
    expect(resolveNav(pivoted, { site: 6 }, 4).pivots).toEqual([]);
    expect(resolveNav(pivoted, { dash: 7 }, 4).pivots).toEqual([]);
    expect(resolveNav(pivoted, { range: '7d' }, 4).pivots).toBeUndefined();
  });

  it('compares pivot state by value', () => {
    const pv = [{ widget: 'refs', dim: 'country' as const }];
    expect(sameViewState(at({ pivots: [...pv] }), at({ pivots: [...pv] }))).toBe(true);
    expect(sameViewState(at({ pivots: pv }), at({}))).toBe(false);
  });
});
