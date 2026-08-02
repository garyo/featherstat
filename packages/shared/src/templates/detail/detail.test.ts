import { describe, expect, it } from 'vitest';
import { DASHBOARD_LAYOUT_VERSION, DashboardSchema } from '../../index.ts';
import { dashboardBatchIssue } from '../../widgets.ts';
import { DETAIL_DIMENSIONS, isDetailDimension } from './dims.ts';
import { DETAIL_TEMPLATES } from './index.ts';

/**
 * The detail-template half of the registry ratchet (templates.test.ts is the
 * library half): every entity template must build a schema-valid document that
 * `collectBatch` can turn into one fetchable request. The contract suite at
 * `test/contract/` additionally executes each one against the corpus.
 */

/** Values with the characters that break naive URL/filter plumbing. */
const VALUES: Record<string, string> = {
  path: '/blog/why: colons&questions?x=1',
  ref_domain: 'news.ycombinator.com',
  utm_campaign: 'summer:launch',
};

describe('DETAIL_TEMPLATES', () => {
  it('covers exactly the drillable dimensions, each under its own key', () => {
    expect(Object.keys(DETAIL_TEMPLATES).sort()).toEqual([...DETAIL_DIMENSIONS].sort());
    for (const [dim, template] of Object.entries(DETAIL_TEMPLATES)) {
      expect(template.dim).toBe(dim);
      expect(isDetailDimension(dim)).toBe(true);
    }
    expect(isDetailDimension('country')).toBe(false);
  });

  for (const template of Object.values(DETAIL_TEMPLATES)) {
    describe(`detail '${template.dim}'`, () => {
      const value = VALUES[template.dim] ?? 'x';
      const built = template.build(7, value);

      it('builds a schema-valid document at the current layout version', () => {
        expect(DashboardSchema.parse(built)).toEqual(built);
        expect(built.version).toBe(DASHBOARD_LAYOUT_VERSION);
        expect(built.site).toBe(7);
      });

      it('batches — including derived companions — within the request cap', () => {
        expect(dashboardBatchIssue(built)).toBeUndefined();
      });

      it('binds the entity into every widget query, awkward characters intact', () => {
        // The binding is per-widget (a hit filter, a session-scope filter, a
        // kind's own `path`, or the entry/exit dims) — not one request filter,
        // which could not say all of those at once. Every query must carry it.
        for (const spec of built.grid) {
          expect(JSON.stringify(spec.query), spec.id).toContain(JSON.stringify(value).slice(1, -1));
        }
      });

      it('is rebuilt fresh on every call, never a shared mutable document', () => {
        expect(template.build(7, value)).not.toBe(built);
      });
    });
  }
});
