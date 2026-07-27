import { describe, expect, it } from 'vitest';
import { countryName, flagEmoji } from './geo.ts';

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
