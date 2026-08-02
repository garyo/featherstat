import { describe, expect, it } from 'vitest';
import { buildUtmUrl, emptyUtmDraft, normalizationWarnings, type UtmDraft } from './utm-builder.ts';

const draft = (over: Partial<UtmDraft>): UtmDraft => ({ ...emptyUtmDraft(), ...over });

describe('buildUtmUrl', () => {
  it('needs domain, campaign and source before it answers', () => {
    expect(buildUtmUrl(emptyUtmDraft())).toBeUndefined();
    expect(buildUtmUrl(draft({ domain: 'blog.test', campaign: 'launch' }))).toBeUndefined();
    expect(
      buildUtmUrl(draft({ domain: 'blog.test', campaign: 'launch', source: 'newsletter' })),
    ).toBe('https://blog.test/?utm_campaign=launch&utm_source=newsletter');
  });

  it('defaults the scheme to https and keeps an explicit one', () => {
    const base = { campaign: 'launch', source: 'mastodon', medium: 'social' };
    expect(buildUtmUrl(draft({ domain: 'http://localhost:8080', path: '/post', ...base }))).toBe(
      'http://localhost:8080/post?utm_campaign=launch&utm_source=mastodon&utm_medium=social',
    );
  });

  it('normalizes the path and url-encodes values', () => {
    expect(
      buildUtmUrl(draft({ domain: 'a.test', path: 'docs', campaign: 'spring sale', source: 'x' })),
    ).toBe('https://a.test/docs?utm_campaign=spring+sale&utm_source=x');
  });

  it('answers undefined for an unparseable domain', () => {
    expect(buildUtmUrl(draft({ domain: 'https://', campaign: 'c', source: 's' }))).toBeUndefined();
  });
});

describe('normalizationWarnings', () => {
  it('flags exactly the values ingest would store differently', () => {
    const warnings = normalizationWarnings(
      draft({ campaign: 'Spring  Sale', source: 'newsletter', medium: ' Email ' }),
    );
    expect(warnings).toEqual([
      { field: 'campaign', stored: 'spring sale' },
      { field: 'medium', stored: 'email' },
    ]);
  });

  it('is silent when everything is already canonical', () => {
    expect(
      normalizationWarnings(draft({ campaign: 'launch', source: 'hn', medium: 'social' })),
    ).toEqual([]);
  });
});
