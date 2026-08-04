import { describe, expect, it } from 'vitest';
import { canonicalReferrerDomain, referrerAttribution } from './referrers.ts';

/**
 * Referrer canonicalization (docs/03 § Attribution). The report this exists to
 * fix had `go.bsky.app` and `bsky.app` as two rows; the risk it introduces is
 * over-collapsing, so both directions are pinned here.
 */

describe('canonicalReferrerDomain', () => {
  it('collapses subdomains onto the registrable domain', () => {
    const cases: Array<[string, string]> = [
      ['go.bsky.app', 'bsky.app'],
      ['bsky.app', 'bsky.app'],
      ['m.facebook.com', 'facebook.com'],
      ['l.facebook.com', 'facebook.com'],
      ['ca.search.yahoo.com', 'yahoo.com'],
      ['old.reddit.com', 'reddit.com'],
      ['out.reddit.com', 'reddit.com'],
      // The multi-label public suffix is the whole point of using the list.
      ['www.google.co.uk', 'google.co.uk'],
      ['images.google.com.au', 'google.com.au'],
    ];
    for (const [host, canonical] of cases) {
      expect(canonicalReferrerDomain(host), host).toBe(canonical);
    }
  });

  it('subsumes stripping www, casing and the silent root label', () => {
    expect(canonicalReferrerDomain('www.example.com')).toBe('example.com');
    expect(canonicalReferrerDomain('WWW.Example.COM')).toBe('example.com');
    expect(canonicalReferrerDomain('example.com.')).toBe('example.com');
  });

  it('keeps hosts whose subdomain is a genuinely different source', () => {
    expect(canonicalReferrerDomain('news.google.com')).toBe('news.google.com');
    expect(canonicalReferrerDomain('www.news.google.com')).toBe('news.google.com');
    expect(canonicalReferrerDomain('news.ycombinator.com')).toBe('news.ycombinator.com');
    // Not exempt, so the ordinary rule applies — the exemption is a list, not a habit.
    expect(canonicalReferrerDomain('maps.google.com')).toBe('google.com');
  });

  it('maps the alias table, including android-app package ids', () => {
    const cases: Array<[string, string]> = [
      ['t.co', 'twitter.com'],
      ['fb.me', 'facebook.com'],
      ['lnkd.in', 'linkedin.com'],
      ['youtu.be', 'youtube.com'],
      ['com.slack', 'slack.com'],
      // eTLD+1 alone answers 'android.gm' here, which names nothing.
      ['com.google.android.gm', 'gmail.com'],
    ];
    for (const [host, canonical] of cases) {
      expect(canonicalReferrerDomain(host), host).toBe(canonical);
    }
  });

  it('applies aliases to the collapsed form too', () => {
    expect(canonicalReferrerDomain('www.youtu.be')).toBe('youtube.com');
    expect(canonicalReferrerDomain('m.t.co')).toBe('twitter.com');
  });

  it('answers something for hosts the public suffix list cannot place', () => {
    expect(canonicalReferrerDomain('localhost')).toBe('localhost');
    expect(canonicalReferrerDomain('192.0.2.5')).toBe('192.0.2.5');
    expect(canonicalReferrerDomain('intranet')).toBe('intranet');
  });

  it('never collapses a host that is itself a public suffix to nothing', () => {
    // ICANN suffixes only: with private suffixes on, tldts places `vercel.app`
    // and `notion.site` as suffixes and answers null for them.
    expect(canonicalReferrerDomain('vercel.app')).toBe('vercel.app');
    expect(canonicalReferrerDomain('myapp.vercel.app')).toBe('vercel.app');
    expect(canonicalReferrerDomain('notion.site')).toBe('notion.site');
  });
});

describe('referrerAttribution', () => {
  const OWN = ['example.com'];

  it('stores the received host only when canonicalization changed it', () => {
    expect(referrerAttribution('https://go.bsky.app/profile/x', OWN)).toEqual({
      ref_domain: 'bsky.app',
      ref_domain_raw: 'go.bsky.app',
      ref_type: 'social',
    });
    expect(referrerAttribution('https://bsky.app/profile/x', OWN)).toEqual({
      ref_domain: 'bsky.app',
      ref_domain_raw: null,
      ref_type: 'social',
    });
  });

  it('reports no referrer for a missing or unparseable one', () => {
    for (const referrer of [undefined, '', 'not a url']) {
      expect(referrerAttribution(referrer, OWN)).toEqual({
        ref_domain: null,
        ref_domain_raw: null,
        ref_type: undefined,
      });
    }
  });

  it('classifies on the canonical domain, so an alias reaches its entry', () => {
    // `fb.me` is in no search/social table; `facebook.com` is.
    expect(referrerAttribution('https://fb.me/xyz', OWN).ref_type).toBe('social');
    expect(referrerAttribution('https://ca.search.yahoo.com/search?p=x', OWN).ref_type).toBe(
      'search',
    );
    // A KEEP_DISTINCT host still reaches its parent's entry through the walk.
    expect(referrerAttribution('https://news.google.com/read/x', OWN).ref_type).toBe('search');
  });

  it('matches own domains on the RECEIVED host, so a subdomain site keeps working', () => {
    expect(referrerAttribution('https://blog.example.com/p', OWN).ref_type).toBe('internal');
    // The site is registered under a subdomain: its own pages must still be
    // internal even though their eTLD+1 is not the registered domain.
    const sub = ['docs.example.com'];
    expect(referrerAttribution('https://docs.example.com/p', sub).ref_type).toBe('internal');
    expect(referrerAttribution('https://docs.example.com/p', sub).ref_domain).toBe('example.com');
  });

  it('falls back to referral for anything unknown', () => {
    expect(referrerAttribution('https://blog.partner.org/post', OWN)).toEqual({
      ref_domain: 'partner.org',
      ref_domain_raw: 'blog.partner.org',
      ref_type: 'referral',
    });
  });
});
