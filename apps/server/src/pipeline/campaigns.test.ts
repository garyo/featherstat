import { canonicalUtmValue, type Hit } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { openTestDb, T0, VISITOR } from '../../test/rows.ts';
import { replaceCampaignAliases, type Site, withWriteTransaction } from '../db/index.ts';
import { AliasCache, plainNormalizer } from './campaigns.ts';
import type { DeviceInfo } from './enrich.ts';
import { Sessionizer } from './sessionizer.ts';

const SITE: Site = {
  id: 1,
  name: 'one',
  domains: ['one.test'],
  timezone: 'America/New_York',
  created_at: 0,
};

const DEVICE: DeviceInfo = {
  browser: 'Chrome',
  browser_version: '126.0.0.0',
  os: 'Windows',
  device_type: 'desktop',
};

describe('canonicalUtmValue', () => {
  it('trims, collapses internal whitespace and lowercases', () => {
    expect(canonicalUtmValue('  Email\t Newsletter  ')).toBe('email newsletter');
    expect(canonicalUtmValue('Google')).toBe('google');
    expect(canonicalUtmValue('already canonical')).toBe('already canonical');
  });
});

describe('plainNormalizer', () => {
  it('reports raw only when it differs', () => {
    expect(plainNormalizer(1, 'source', 'email')).toEqual({ normalized: 'email' });
    expect(plainNormalizer(1, 'source', ' Email ')).toEqual({
      normalized: 'email',
      raw: ' Email ',
    });
  });

  it('canonicalizes an all-whitespace value to nothing, raw kept', () => {
    expect(plainNormalizer(1, 'medium', '   ')).toEqual({ normalized: null, raw: '   ' });
  });
});

describe('AliasCache', () => {
  it('prefers the site row over the install-wide one, and misses cleanly', () => {
    const db = openTestDb(2);
    withWriteTransaction(db, () => {
      replaceCampaignAliases(db, 0, [{ field: 'source', alias: 'em', canonical: 'email' }]);
      replaceCampaignAliases(db, 1, [{ field: 'source', alias: 'em', canonical: 'newsletter' }]);
    });
    const cache = new AliasCache(db);
    expect(cache.resolve(1, 'source', 'em')).toBe('newsletter'); // site row wins
    expect(cache.resolve(2, 'source', 'em')).toBe('email'); // install-wide fallback
    expect(cache.resolve(2, 'medium', 'em')).toBeUndefined(); // field-scoped
    expect(cache.resolve(2, 'source', 'other')).toBeUndefined();
    db.close();
  });

  it('reloads after invalidate()', () => {
    const db = openTestDb();
    const cache = new AliasCache(db);
    expect(cache.resolve(1, 'campaign', 'spring')).toBeUndefined(); // loads the (empty) table
    withWriteTransaction(db, () => {
      replaceCampaignAliases(db, 1, [
        { field: 'campaign', alias: 'spring', canonical: 'spring_launch' },
      ]);
    });
    // The loaded table is authoritative until invalidated — read-only at ingest.
    expect(cache.resolve(1, 'campaign', 'spring')).toBeUndefined();
    cache.invalidate();
    expect(cache.resolve(1, 'campaign', 'spring')).toBe('spring_launch');
    db.close();
  });
});

describe('sessionizer normalization (docs/03 § Campaigns)', () => {
  function firstHit(sessionizer: Sessionizer, url: string) {
    const hit: Hit = { siteId: 1, type: 'pageview', url };
    const stored = sessionizer.process({
      site: SITE,
      hit,
      visitorId: VISITOR,
      now: T0,
      device: DEVICE,
      geo: null,
      lang: 'en-US',
    });
    if (stored === undefined) throw new Error('pageview was dropped');
    return stored;
  }

  it('stores normalized utm values, raw only where it differed', () => {
    const s = new Sessionizer();
    const { event, session } = firstHit(
      s,
      'https://one.test/?utm_source=%20Email%20&utm_medium=cpc&utm_campaign=Spring%20%20Launch',
    );
    expect(session.utm_source).toBe('email');
    expect(session.utm_source_raw).toBe(' Email ');
    expect(session.utm_medium).toBe('cpc');
    expect(session.utm_medium_raw).toBeNull(); // already canonical — raw stays NULL
    expect(session.utm_campaign).toBe('spring launch');
    expect(session.utm_campaign_raw).toBe('Spring  Launch');
    // Events denormalize the session's first-touch attribution, raw included.
    expect(event.utm_source).toBe('email');
    expect(event.utm_source_raw).toBe(' Email ');
    expect(event.utm_medium_raw).toBeNull();
  });

  it('applies aliases through the injected cache normalizer', () => {
    const db = openTestDb();
    withWriteTransaction(db, () => {
      replaceCampaignAliases(db, 1, [{ field: 'source', alias: 'email', canonical: 'newsletter' }]);
    });
    const cache = new AliasCache(db);
    const s = new Sessionizer(undefined, cache.normalizer);
    const { session } = firstHit(s, 'https://one.test/?utm_source=Email');
    expect(session.utm_source).toBe('newsletter');
    expect(session.utm_source_raw).toBe('Email'); // the as-received value, pre-alias
    db.close();
  });
});
