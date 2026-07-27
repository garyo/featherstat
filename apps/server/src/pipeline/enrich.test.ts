import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DESKTOP_UA, GOOGLEBOT_UA } from '../../test/rows.ts';
import { isBotUserAgent, parseUserAgent, preferredLanguage } from './enrich.ts';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const SMART_TV_UA =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1';

describe('isBotUserAgent', () => {
  it('flags crawlers', () => {
    expect(isBotUserAgent(GOOGLEBOT_UA)).toBe(true);
    expect(isBotUserAgent('curl/8.6.0')).toBe(true);
  });

  it('passes real browsers and empty UAs', () => {
    expect(isBotUserAgent(DESKTOP_UA)).toBe(false);
    expect(isBotUserAgent('')).toBe(false);
  });
});

describe('parseUserAgent', () => {
  it('parses a desktop browser', () => {
    expect(parseUserAgent(DESKTOP_UA)).toEqual({
      browser: 'Chrome',
      browser_version: '126.0.0.0',
      os: 'Windows',
      device_type: 'desktop',
    });
  });

  it('maps device types to desktop/mobile/tablet/other', () => {
    expect(parseUserAgent(IPHONE_UA).device_type).toBe('mobile');
    expect(parseUserAgent(IPAD_UA).device_type).toBe('tablet');
    expect(parseUserAgent(SMART_TV_UA).device_type).toBe('other');
    expect(parseUserAgent('').device_type).toBe('desktop');
  });

  it('caches by UA string', () => {
    expect(parseUserAgent(DESKTOP_UA)).toBe(parseUserAgent(DESKTOP_UA));
  });
});

describe('ua-parser-js license discipline (CLAUDE.md)', () => {
  it('stays on MIT v1 — v2 relicensed AGPL', () => {
    const pkg = createRequire(import.meta.url)('ua-parser-js/package.json') as {
      version: string;
      license: string;
    };
    expect(pkg.version.startsWith('1.')).toBe(true);
    expect(pkg.license).toBe('MIT');
  });
});

describe('preferredLanguage', () => {
  it('prefers the Accept-Language header over the lang param', () => {
    expect(preferredLanguage('en-US,en;q=0.9,fr;q=0.8', 'de')).toBe('en-US');
  });

  it('falls back to the hit lang, then null', () => {
    expect(preferredLanguage(undefined, 'de')).toBe('de');
    expect(preferredLanguage('', undefined)).toBeNull();
    expect(preferredLanguage(undefined, undefined)).toBeNull();
  });
});
