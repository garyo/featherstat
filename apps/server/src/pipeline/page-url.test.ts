import { MAX_URL_CHARS } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import {
  boundUrl,
  CAMPAIGN_PARAMS,
  cleanPageUrl,
  cleanSearch,
  cleanStoredPath,
  clickIdSource,
  isTrackingParam,
  parseStoredPath,
  synthesizedCampaign,
} from './page-url.ts';

describe('cleanPageUrl / cleanSearch (docs/03 § Page identity)', () => {
  it('strips a click id and collapses an emptied query to the plain pathname', () => {
    const url = new URL('https://x.test/blog/ai-future-of-mathematics/?fbclid=IwAR123abc');
    expect(cleanPageUrl(url)).toBe('/blog/ai-future-of-mathematics/');
  });

  it('keeps page-identity params: the docs/04 rule survives, refined', () => {
    expect(cleanPageUrl(new URL('https://x.test/list?page=2'))).toBe('/list?page=2');
    expect(cleanPageUrl(new URL('https://x.test/search?q=owls'))).toBe('/search?q=owls');
  });

  it('strips only the tracking params, preserving survivor order and text', () => {
    const url = new URL('https://x.test/a?b=1&gclid=XYZ&page=2&utm_source=news&q=a%2Bb');
    expect(cleanPageUrl(url)).toBe('/a?b=1&page=2&q=a%2Bb');
  });

  it('strips every campaign family the sessionizer reads (utm_*, mtm_*, pk_*)', () => {
    const url = new URL(
      'https://x.test/?utm_source=a&utm_medium=b&utm_campaign=c&mtm_source=d&pk_campaign=e&pk_kwd=f',
    );
    expect(cleanPageUrl(url)).toBe('/');
  });

  it('strips every name attribution reads, and the legacy Matomo keyword too', () => {
    for (const name of [...Object.values(CAMPAIGN_PARAMS).flat(), 'matomo_kwd', 'piwik_kwd']) {
      expect(isTrackingParam(name), name).toBe(true);
    }
    expect(cleanSearch('?piwik_campaign=x&page=2&matomo_kwd=y')).toBe('?page=2');
  });

  it('strips the whole closed click/identity-id list', () => {
    for (const param of [
      'fbclid',
      'gclid',
      'gbraid',
      'wbraid',
      'dclid',
      'msclkid',
      'twclid',
      'ttclid',
      'li_fat_id',
      'igshid',
      'igsh',
      'mc_eid',
      'mc_cid',
      'yclid',
      '_hsenc',
      '_hsmi',
      'mkt_tok',
      'oly_enc_id',
      'oly_anon_id',
      'vero_id',
      's_kwcid',
    ]) {
      expect(isTrackingParam(param), param).toBe(true);
      expect(cleanPageUrl(new URL(`https://x.test/p?${param}=v`)), param).toBe('/p');
    }
  });

  it('is a closed list: look-alike params are page identity and stay', () => {
    for (const param of ['fbclid2', 'id', 'clid', 'utm', 'pkg', 'mtms']) {
      expect(isTrackingParam(param), param).toBe(false);
    }
    expect(cleanPageUrl(new URL('https://x.test/p?id=5&fbclid=x'))).toBe('/p?id=5');
  });

  it('returns an untouched search string as-is, empty included', () => {
    expect(cleanSearch('')).toBe('');
    expect(cleanSearch('?a=1&b=2')).toBe('?a=1&b=2');
  });

  it('never throws on undecodable param names', () => {
    expect(cleanSearch('?%E0%A4%A=1&fbclid=x')).toBe('?%E0%A4%A=1');
  });
});

describe('cleanStoredPath (the importer heals history)', () => {
  it('re-derives a stored pathname+search through the same rule', () => {
    expect(cleanStoredPath('/blog/post/?fbclid=IwAR1')).toBe('/blog/post/');
    expect(cleanStoredPath('/list?page=2&gclid=abc')).toBe('/list?page=2');
  });

  it('leaves query-less and already-clean paths byte-identical', () => {
    expect(cleanStoredPath('/docs')).toBe('/docs');
    expect(cleanStoredPath('/search?q=owls')).toBe('/search?q=owls');
  });

  it('leaves malformed input alone rather than mangling it', () => {
    // v1 stored an unparseable url verbatim as path text (sessionizer).
    expect(cleanStoredPath('not a url')).toBe('not a url');
    expect(parseStoredPath('/a?b=1')?.searchParams.get('b')).toBe('1');
  });
});

describe('clickIdSource (docs/03 § Attribution, synthesized)', () => {
  const of = (query: string) => clickIdSource(new URL(`https://x.test/?${query}`).searchParams);

  it('maps each platform click id to its industry-standard source/medium', () => {
    expect(of('gclid=x')).toEqual({ source: 'google', medium: 'cpc' });
    expect(of('gbraid=x')).toEqual({ source: 'google', medium: 'cpc' });
    expect(of('wbraid=x')).toEqual({ source: 'google', medium: 'cpc' });
    expect(of('dclid=x')).toEqual({ source: 'google', medium: 'cpc' });
    expect(of('fbclid=x')).toEqual({ source: 'facebook', medium: 'social' });
    expect(of('msclkid=x')).toEqual({ source: 'bing', medium: 'cpc' });
    expect(of('twclid=x')).toEqual({ source: 'twitter', medium: 'social' });
    expect(of('ttclid=x')).toEqual({ source: 'tiktok', medium: 'social' });
    expect(of('li_fat_id=x')).toEqual({ source: 'linkedin', medium: 'social' });
    expect(of('igshid=x')).toEqual({ source: 'instagram', medium: 'social' });
    expect(of('igsh=x')).toEqual({ source: 'instagram', medium: 'social' });
  });

  it('names no platform for identity-only ids, empty values, or none', () => {
    expect(of('mc_eid=x')).toBeUndefined();
    expect(of('yclid=x')).toBeUndefined();
    expect(of('fbclid=')).toBeUndefined();
    expect(of('page=2')).toBeUndefined();
  });

  it('first match wins when several click ids ride one URL', () => {
    expect(of('fbclid=a&gclid=b')).toEqual({ source: 'google', medium: 'cpc' });
  });
});

describe('synthesizedCampaign', () => {
  it('normalizes source/medium, invents no campaign, keeps every raw NULL', () => {
    const normalize = (_site: number, _field: string, value: string) => ({
      normalized: value === 'facebook' ? 'meta' : value, // an operator alias
    });
    expect(synthesizedCampaign({ source: 'facebook', medium: 'social' }, 1, normalize)).toEqual({
      utm_source: 'meta',
      utm_medium: 'social',
      utm_campaign: null,
      utm_source_raw: null,
      utm_medium_raw: null,
      utm_campaign_raw: null,
    });
  });
});

describe('boundUrl (an over-long URL is cut, never dropped)', () => {
  const PAGE = 'https://pcons.org/search';

  it('returns a URL that fits untouched', () => {
    const url = `${PAGE}?q=owls&utm_source=hn`;
    expect(boundUrl(url)).toBe(url);
  });

  it('keeps the attribution params first, then the page params that still fit', () => {
    const url = `${PAGE}?q=${'o'.repeat(3_000)}&page=2&utm_source=hn&pk_cpn=launch`;
    const bounded = boundUrl(url);
    expect(bounded).toBe(`${PAGE}?utm_source=hn&pk_cpn=launch&page=2`);
    expect(bounded.length).toBeLessThanOrEqual(MAX_URL_CHARS);
  });

  it('fills the room it has, and never cuts a pair mid-value', () => {
    const fits = `a=${'x'.repeat(40)}`;
    const bounded = boundUrl(`${PAGE}?${fits}&b=${'y'.repeat(80)}&c=1`, PAGE.length + 50);
    expect(bounded).toBe(`${PAGE}?${fits}&c=1`);
  });

  it('slices a URL whose path alone is too long', () => {
    const url = `https://pcons.org/${'p'.repeat(3_000)}?utm_source=hn`;
    expect(boundUrl(url)).toBe(url.slice(0, MAX_URL_CHARS));
  });
});
