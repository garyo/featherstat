import { describe, expect, it } from 'vitest';
import { DASHBOARD_LAYOUT_VERSION, DashboardSchema, MAX_QUERIES_PER_BATCH } from '../index.ts';
import { dashboardBatchIssue } from '../widgets.ts';
import { DASHBOARD_TEMPLATES, dashboardTemplate, templatesForScope } from './index.ts';

/**
 * The template registry ratchet: every shipped template must be a document the
 * schema accepts AND one `collectBatch` can turn into a fetchable request — a
 * template that overflows the batch is a dashboard nobody can open, and it must
 * fail here rather than in a browser.
 */

/** Enough sites to be a real install; small enough that R20 page queries fit. */
const SITE_IDS = [1, 2, 3, 4, 5, 6];

describe('DASHBOARD_TEMPLATES', () => {
  it('has unique ids and a shipped default first for each scope', () => {
    const ids = DASHBOARD_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(templatesForScope('site')[0]?.id).toBe('overview');
    expect(templatesForScope('all')[0]?.id).toBe('all-sites');
  });

  it('finds a template by id, and only by a real one', () => {
    expect(dashboardTemplate('content')?.name).toBe('Content');
    expect(dashboardTemplate('nope')).toBeUndefined();
  });

  for (const template of DASHBOARD_TEMPLATES) {
    describe(`template '${template.id}'`, () => {
      const built = template.build(template.scope === 'all' ? 'all' : 7, SITE_IDS);

      it('builds a schema-valid document at the current layout version', () => {
        expect(DashboardSchema.parse(built)).toEqual(built);
        expect(built.version).toBe(DASHBOARD_LAYOUT_VERSION);
        expect(built.site).toBe(template.scope === 'all' ? 'all' : 7);
      });

      it('batches — including derived companions — within the request cap', () => {
        expect(dashboardBatchIssue(built)).toBeUndefined();
      });

      it('is rebuilt fresh on every call, never a shared mutable document', () => {
        expect(template.build(template.scope === 'all' ? 'all' : 7, SITE_IDS)).not.toBe(built);
      });
    });
  }

  it('stamps the requested site into a site template', () => {
    expect(dashboardTemplate('acquisition')?.build(42).site).toBe(42);
  });

  it('threads the live site ids into the all-sites card grid', () => {
    const built = dashboardTemplate('all-sites')?.build('all', [3, 9]);
    expect(built?.grid[0]?.options.siteIds).toEqual([3, 9]);
    // One card query + totals + one page query per site — still far under the cap.
    expect(dashboardBatchIssue(built ?? { version: 1, name: 'x', site: 'all', grid: [] })).toBe(
      undefined,
    );
    expect(SITE_IDS.length + 2).toBeLessThan(MAX_QUERIES_PER_BATCH);
  });
});
