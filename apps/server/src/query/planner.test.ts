import type { SiteWindow } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { planMetricRoute } from './planner.ts';

const windows: SiteWindow[] = [
  { siteId: 1, timezone: 'UTC', from: '2026-07-01', to: '2026-07-31' },
];

describe('planMetricRoute and prop dims', () => {
  it('routes a prop-free eligible shape to rollups — the control this test leans on', () => {
    expect(planMetricRoute({ id: 'q', metrics: ['pageviews'], dim: 'path' }, [], windows)).toBe(
      'rollup',
    );
  });

  it('routes every prop-dim shape to raw: grouping, own filters, global filters', () => {
    expect(
      planMetricRoute({ id: 'q', metrics: ['pageviews'], dim: 'prop:plan' }, [], windows),
    ).toBe('raw');
    expect(
      planMetricRoute(
        {
          id: 'q',
          metrics: ['pageviews'],
          filters: [{ dim: 'prop:plan', op: 'eq', value: 'pro' }],
        },
        [],
        windows,
      ),
    ).toBe('raw');
    expect(
      planMetricRoute(
        { id: 'q', metrics: ['pageviews'] },
        [{ dim: 'prop:plan', op: 'eq', value: 'pro' }],
        windows,
      ),
    ).toBe('raw');
  });
});
