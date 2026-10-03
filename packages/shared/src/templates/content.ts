import { buildDashboard } from './build.ts';
import type { DashboardTemplate } from './index.ts';

/**
 * How the writing is doing: rankings by page, where sessions begin and end
 * (`entry_path`/`exit_path` are session dimensions, so those lists rank session
 * metrics), and how deeply pages are read — dwell per page plus the dwell and
 * scroll histograms over the same measured legs (docs/04 § 3 `distribution`) —
 * and the paths asked for that do not exist, with the pages linking to them.
 */
export const contentTemplate: DashboardTemplate = {
  id: 'content',
  name: 'Content',
  scope: 'site',
  build: (site) =>
    buildDashboard({
      name: 'Content',
      site,
      grid: [
        {
          id: 'kpis',
          viz: 'kpi-row',
          w: 12,
          h: 1,
          query: {
            id: 'kpis',
            metrics: [
              'pageviews',
              'visitors',
              'engaged_ms',
              'engaged_sessions',
              'avg_engagement',
              'views_per_visit',
            ],
          },
          options: { tiles: ['pageviews', 'visitors', 'avg_engagement', 'views_per_visit'] },
        },
        {
          id: 'pages',
          viz: 'bar-list',
          title: 'Top pages',
          w: 6,
          h: 2,
          query: { id: 'pages', metrics: ['pageviews'], dim: 'path', limit: 10 },
        },
        {
          id: 'dwell',
          viz: 'dwell',
          title: 'Time on page',
          w: 6,
          h: 2,
          query: { id: 'dwell', kind: 'dwell', limit: 10 },
        },
        {
          id: 'entries',
          viz: 'bar-list',
          title: 'Entry pages',
          w: 6,
          h: 2,
          query: { id: 'entries', metrics: ['visits'], dim: 'entry_path', limit: 8 },
        },
        {
          id: 'exits',
          viz: 'bar-list',
          title: 'Exit pages',
          w: 6,
          h: 2,
          query: { id: 'exits', metrics: ['visits'], dim: 'exit_path', limit: 8 },
        },
        {
          id: 'dwellhist',
          viz: 'histogram',
          title: 'Time-on-page distribution',
          w: 6,
          h: 2,
          query: { id: 'dwellhist', kind: 'distribution', of: 'dwell' },
        },
        {
          id: 'scrollhist',
          viz: 'histogram',
          title: 'Scroll depth',
          w: 6,
          h: 2,
          query: { id: 'scrollhist', kind: 'distribution', of: 'scroll' },
        },
        {
          id: 'broken',
          viz: 'broken-links',
          title: 'Broken links',
          w: 6,
          h: 2,
          query: { id: 'broken', kind: 'missing', limit: 8 },
        },
      ],
    }),
};
