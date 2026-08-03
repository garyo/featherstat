import { overviewTemplate } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { applyPivots, isPivotable, pivotDims } from './pivots.ts';

const dashboard = overviewTemplate.build(1);

describe('applyPivots', () => {
  it('swaps the named widget’s breakdown and leaves every other spec untouched', () => {
    const pivoted = applyPivots(dashboard, [{ widget: 'refs', dim: 'country' }]);
    const refs = pivoted.grid.find((spec) => spec.id === 'refs');
    if (refs?.query === undefined || 'kind' in refs.query) throw new Error('refs expected');
    expect(refs.query.dim).toBe('country');
    // Metrics, limit and the widget's own id survive — only the dimension moves.
    expect(refs.query.metrics).toEqual(['visitors']);
    expect(refs.query.limit).toBe(8);
    for (const spec of pivoted.grid) {
      if (spec.id !== 'refs') {
        expect(spec).toBe(dashboard.grid.find((original) => original.id === spec.id));
      }
    }
  });

  it('re-derives the display options that follow the dimension', () => {
    // Referrers carries nullLabel 'Direct'; pivoted to country it must read as
    // the geo card does — flags on, unknown group labeled honestly.
    const toCountry = applyPivots(dashboard, [{ widget: 'refs', dim: 'country' }]);
    const refs = toCountry.grid.find((spec) => spec.id === 'refs');
    expect(refs?.options).toMatchObject({ flags: true, nullLabel: 'Unknown' });
    const toPath = applyPivots(dashboard, [{ widget: 'refs', dim: 'path' }]);
    expect(toPath.grid.find((spec) => spec.id === 'refs')?.options.nullLabel).toBeUndefined();
  });

  it('strips the saved title — it described the saved breakdown, not this one', () => {
    // "Top pages" over browser rows is a lie; untitled, the widget's picker
    // becomes the whole heading (BarList).
    const pivoted = applyPivots(dashboard, [{ widget: 'refs', dim: 'country' }]);
    expect(pivoted.grid.find((spec) => spec.id === 'refs')?.title).toBeUndefined();
  });

  it('drops the second grouping — it composed labels for the original dim', () => {
    const pivoted = applyPivots(dashboard, [{ widget: 'events', dim: 'path' }]);
    const events = pivoted.grid.find((spec) => spec.id === 'events');
    if (events?.query === undefined || 'kind' in events.query) throw new Error('events expected');
    expect(events.query.dim).toBe('path');
    expect(events.query.dim2).toBeUndefined();
  });

  it('overlays only bar-list-shaped widgets, never a pinned-shape one', () => {
    const pivoted = applyPivots(dashboard, [
      { widget: 'heatmap', dim: 'country' },
      { widget: 'kpis', dim: 'country' },
      { widget: 'dwell', dim: 'country' },
      { widget: 'no-such-widget', dim: 'country' },
    ]);
    expect(pivoted).toBe(dashboard);
  });

  it('is a no-op object for an empty overlay and for a same-dim pivot', () => {
    expect(applyPivots(dashboard, [])).toBe(dashboard);
    expect(applyPivots(dashboard, [{ widget: 'refs', dim: 'ref_domain' }])).toBe(dashboard);
  });
});

describe('isPivotable', () => {
  const widgetOf = (id: string) => {
    const spec = dashboard.grid.find((entry) => entry.id === id);
    if (spec === undefined) throw new Error(`no '${id}' widget`);
    return spec;
  };

  it('offers the control on breakdown lists only', () => {
    expect(isPivotable(widgetOf('refs'))).toBe(true);
    expect(isPivotable(widgetOf('kpis'))).toBe(false);
    expect(isPivotable(widgetOf('dwell'))).toBe(false);
  });
});

describe('pivotDims', () => {
  it('offers every base dimension but the scope axis for event metrics', () => {
    const dims = pivotDims(['pageviews']);
    expect(dims).toContain('path');
    expect(dims).toContain('ref_domain');
    expect(dims).not.toContain('site');
    expect(pivotDims(['visits'])).toContain('entry_path');
  });

  it('withholds a dim that would block EVERY metric of the widget', () => {
    // A purely session-metric list cannot group by an event-only dim (the whole
    // query would error); a mixed list keeps it (trimming saves the rest).
    expect(pivotDims(['bounce_rate'])).not.toContain('path');
    expect(pivotDims(['visitors'])).not.toContain('entry_path');
    expect(pivotDims(['visitors', 'visits'])).toContain('entry_path');
    expect(pivotDims(['visitors', 'bounce_rate'])).toContain('path');
  });
});
