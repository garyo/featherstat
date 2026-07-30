import { describe, expect, it } from 'vitest';
import { countryName, flagEmoji, subdivisionCode } from './geo.ts';

describe('flagEmoji', () => {
  it('derives the flag from the ISO code, case-insensitively', () => {
    expect(flagEmoji('US')).toBe('🇺🇸');
    expect(flagEmoji('de')).toBe('🇩🇪');
    expect(flagEmoji('Jp')).toBe('🇯🇵');
  });

  it('refuses anything that is not two ASCII letters', () => {
    for (const raw of ['', 'U', 'USA', 'U1', '🇺🇸', 'ÜS', '<b>']) {
      expect(flagEmoji(raw)).toBeUndefined();
    }
  });
});

describe('countryName', () => {
  it('names known regions and passes unknowns through', () => {
    expect(countryName('US')).toBe('United States');
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('not-a-code')).toBe('not-a-code');
  });
});

describe('subdivisionCode', () => {
  // Both forms reach it: DB-IP City Lite stores names, the Matomo importer codes.
  it('codes a subdivision name, and passes a code straight through', () => {
    expect(subdivisionCode('Massachusetts')).toBe('MA');
    expect(subdivisionCode('North Carolina')).toBe('NC');
    expect(subdivisionCode('District of Columbia')).toBe('DC');
    expect(subdivisionCode('Ontario')).toBe('ON');
    expect(subdivisionCode('Québec')).toBe('QC');
    expect(subdivisionCode('MA')).toBe('MA');
  });

  it('is undefined for anything it does not know, so callers can fall back', () => {
    for (const raw of ['', 'Devon', 'Bavaria', 'massachusetts', 'Freedonia']) {
      expect(subdivisionCode(raw)).toBeUndefined();
    }
  });
});
