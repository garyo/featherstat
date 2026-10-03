import {
  DASHBOARD_TEMPLATES,
  type QueryResponse,
  QueryResponseSchema,
  type RangePreset,
} from '@featherstat/shared';
import { DETAIL_TEMPLATES } from '@featherstat/shared/detail-templates';
import { describe, expect, it } from 'vitest';
import { answer, CONTRACT_SITE, corpus, useContractDb } from './corpus.ts';

/**
 * The web checks every `/api/query` body against `QueryResponseSchema` before a
 * widget reads it (apps/web/src/lib/api.ts). That check is only honest if it
 * gives back exactly what the server sent: a field the server grows and the
 * schema forgets would be stripped without a word, and a schema drawn tighter
 * than the server would refuse a real answer and blank a dashboard. So every
 * shipped template's real answer goes through it, over the ranges whose
 * windows differ in kind — a rolling `24h` carries instants, `today` a clipped
 * hourly axis, a long range whole days.
 */

useContractDb();

const RANGES: readonly RangePreset[] = ['24h', 'today', '90d'];
const siteIds = corpus.sites.map((site) => site.id);
const entities = {
  path: '/timeline',
  ref_domain: 'news.ycombinator.com',
  utm_campaign: 'spring-release',
};

function roundTrips(response: QueryResponse): void {
  // Through JSON first: the web parses what came over the wire, not live objects.
  const wire: unknown = JSON.parse(JSON.stringify(response));
  expect(QueryResponseSchema.parse(wire)).toEqual(wire);
}

describe('every real answer passes the schema the web checks it with, unchanged', () => {
  for (const range of RANGES) {
    for (const template of DASHBOARD_TEMPLATES) {
      it(`'${template.id}' over ${range}`, () => {
        const all = template.scope === 'all';
        const built = all ? template.build('all', siteIds) : template.build(CONTRACT_SITE);
        roundTrips(answer(built, { range, site: all ? 'all' : CONTRACT_SITE }).response);
      });
    }
  }

  for (const template of Object.values(DETAIL_TEMPLATES)) {
    it(`the '${template.dim}' detail view`, () => {
      const built = template.build(CONTRACT_SITE, entities[template.dim]);
      roundTrips(answer(built, { site: CONTRACT_SITE }).response);
    });
  }

  it('refuses a body that is not an answer', () => {
    expect(QueryResponseSchema.safeParse({ results: { a: { rows: 'nope' } } }).success).toBe(false);
  });
});
