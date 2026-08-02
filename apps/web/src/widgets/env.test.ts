import {
  type QueryResponse,
  type RealtimeEngagement,
  type RealtimeHit,
  type SiteInfo,
  VizTypeSchema,
} from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { activeCount, visitorRows } from '../lib/realtime.ts';
import { CAPABILITY_NOTE, dashboardEnv, gridEnv, missingCapability, NEEDS } from './env.ts';
import type { AppEnv, WidgetEnv } from './types.ts';

/**
 * The environment every widget renders from. Three defects lived here, all the
 * same shape: a caller left a capability off and the compiler had nothing to
 * say, because every field but `spec` was optional. The fields are now required
 * and nullable, so the omissions below are unrepresentable — these tests hold
 * the behaviour that used to be missing, and `svelte-check` holds the rest.
 */

const NOW = 1_700_000_000_000;

const hit = (over: Partial<RealtimeHit> = {}): RealtimeHit => ({
  siteId: 3,
  ts: NOW - 60_000,
  type: 'pageview',
  visitor: { name: 'Amiable Aardvark', color: 0, ref: 'ref-3-a' },
  ...over,
});

const engaged = (over: Partial<RealtimeEngagement> = {}): RealtimeEngagement => ({
  ref: 'ref-3-a',
  name: 'Amiable Aardvark',
  color: 0,
  siteId: 3,
  engagedMs: 96_000,
  lastTs: NOW - 60_000,
  ...over,
});

const site = (id: number): SiteInfo => ({
  id,
  name: `site-${id}.example`,
  domains: [`site-${id}.example`],
  timezone: 'UTC',
});

/** The app as the Shell hands it over: one stream, one directory, one clock. */
const APP: AppEnv = {
  now: NOW,
  realtime: { active: { 3: 7, 4: 2 }, recent: [hit()], visitorTimes: [engaged()] },
  sites: new Map([[3, site(3)]]),
  onopenrealtime: () => undefined,
  onselectsite: () => undefined,
};

/** A share link carries no session, and says so. */
const SHARED_PAGE: AppEnv = {
  now: NOW,
  realtime: null,
  sites: null,
  onopenrealtime: null,
  onselectsite: null,
};

/** What the grid hands one widget: the view's environment plus its batch share. */
const widgetEnv = (
  env: Omit<WidgetEnv, 'data' | 'headless' | 'highlight' | 'windows' | 'annotations'>,
): WidgetEnv =>
  ({
    ...env,
    windows: null,
    annotations: null,
    data: null,
    headless: false,
    highlight: null,
  }) satisfies WidgetEnv;

describe('a site dashboard gets the whole live stream', () => {
  const env = dashboardEnv(APP, {
    scope: 3,
    range: '30d',
    onfilter: () => undefined,
    ondrill: null,
    onpivot: null,
  });

  it('reads the live count for its own site, not 0', () => {
    // `active-now` on a site dashboard read 0 forever: the view passed the feed
    // and left the counts behind, because they were two optional props.
    expect(activeCount(env.realtime, env.scope)).toBe(7);
    expect(activeCount(env.realtime, 'all')).toBe(9);
  });

  it('shows engaged time in the visitor tally', () => {
    // Same fault, third prop: the tally rendered on a dashboard without the
    // engagement rows, so no row ever carried a duration.
    const rows = visitorRows(env.realtime, env.scope, NOW);
    expect(rows.map((row) => row.engagedMs)).toEqual([96_000]);
  });
});

describe('a shared page says what it lacks', () => {
  const env = widgetEnv(
    dashboardEnv(SHARED_PAGE, {
      scope: 3,
      range: '30d',
      onfilter: null,
      ondrill: null,
      onpivot: null,
    }),
  );

  it('names the missing stream for every realtime viz', () => {
    for (const viz of ['feed', 'active-now', 'visitor-tally', 'realtime-countries'] as const) {
      expect(missingCapability(viz, env)).toBe('realtime');
    }
  });

  it('blames the stream, never the visitors', () => {
    // The cards used to render "No located visitors in the last 30 minutes" and
    // an active-now hero reading 0 — both untrue: nobody had been counted.
    const note = CAPABILITY_NOTE.realtime;
    expect(note).toMatch(/no live stream/i);
    expect(note).not.toMatch(/visitor/i);
  });

  it('still renders the query widgets, which need nothing it withholds', () => {
    const withData = { ...env, data: { phase: 'ready', results: {} } } satisfies WidgetEnv;
    for (const viz of ['kpi-row', 'timeseries', 'bar-list', 'site-cards'] as const) {
      expect(missingCapability(viz, withData)).toBeUndefined();
    }
  });
});

describe('the editor preview and the dashboard share one environment', () => {
  it('carries the range, the filter callback and the realtime jump into edit mode', () => {
    // The editor's caller passed a shorter list of props than the grid's, so the
    // preview lost these four. There is one value now, and both consumers get it.
    const onfilter = () => undefined;
    const env = dashboardEnv(APP, {
      scope: 3,
      range: '7d',
      onfilter,
      ondrill: null,
      onpivot: null,
    });
    expect(env).toEqual({
      now: NOW,
      realtime: APP.realtime,
      sites: APP.sites,
      onopenrealtime: APP.onopenrealtime,
      onselectsite: APP.onselectsite,
      scope: 3,
      rangeLabel: 'last 7 days',
      onfilter,
      ondrill: null,
      onpivot: null,
    });
  });

  it('labels the range it was given, so a title cannot describe another window', () => {
    expect(
      dashboardEnv(APP, {
        scope: 'all',
        range: 'today',
        onfilter: null,
        ondrill: null,
        onpivot: null,
      }).rangeLabel,
    ).toBe('today');
  });
});

describe('needs', () => {
  it('covers every viz in the shared vocabulary', () => {
    expect(Object.keys(NEEDS).sort()).toEqual([...VizTypeSchema.options].sort());
  });

  it('separates the batch readers from the stream readers', () => {
    // CLAUDE.md invariant 7, machine-readable: a widget declares a query or
    // declares none, and the realtime family asks the batch for nothing.
    const streamed = Object.entries(NEEDS)
      .filter(([, needs]) => needs.includes('realtime'))
      .map(([viz]) => viz);
    expect(streamed.sort()).toEqual(['active-now', 'feed', 'realtime-countries', 'visitor-tally']);
    for (const viz of streamed) expect(NEEDS[viz as keyof typeof NEEDS]).not.toContain('data');
  });

  it('withholds a batch reader from a page that runs no batch', () => {
    const realtimePage = widgetEnv(
      dashboardEnv(APP, { scope: 3, range: '30d', onfilter: null, ondrill: null, onpivot: null }),
    );
    expect(missingCapability('timeseries', realtimePage)).toBe('data');
    expect(missingCapability('feed', realtimePage)).toBeUndefined();
  });
});

describe('gridEnv', () => {
  it('takes the windows off the response on screen, never from the caller', () => {
    const windows = [{ siteId: 3, timezone: 'UTC', from: '2026-07-01', to: '2026-07-29' }];
    const response = { results: {}, meta: { generatedInMs: 1, dataVersion: 2, windows } };
    const env = dashboardEnv(APP, {
      scope: 3,
      range: '30d',
      onfilter: null,
      ondrill: null,
      onpivot: null,
    });
    expect(gridEnv(env, response as QueryResponse).windows).toBe(windows);
    expect(gridEnv(env, undefined).windows).toBeNull();
  });
});
