import { describe, expect, it } from 'vitest';
import {
  ExclusionRuleSchema,
  ExclusionSettingsSchema,
  exclusionRuleKind,
  MAX_EXCLUSION_RULES,
} from './exclusions.ts';

describe('exclusionRuleKind', () => {
  it('reads addresses and prefixes as addresses', () => {
    for (const value of ['192.0.2.1', '198.51.100.0/24', '2001:db8::1', '2001:db8::/32', '::1']) {
      expect(exclusionRuleKind(value), value).toBe('address');
    }
  });

  it('reads names as hostnames', () => {
    for (const value of ['home.example.com', 'host.example.net', 'a-b.co.uk']) {
      expect(exclusionRuleKind(value), value).toBe('hostname');
    }
  });

  it('reads an all-hex-digit name as a hostname, not an address', () => {
    // `abc.def` is entirely hex digits and dots; character class alone would
    // misfile it and it would then never resolve.
    expect(exclusionRuleKind('abc.def')).toBe('hostname');
    expect(exclusionRuleKind('cafe.babe')).toBe('hostname');
  });

  it('rejects what is neither', () => {
    for (const value of ['', 'no-dot', 'has space.com', 'trailing.dot.', '-lead.com', 'a..b']) {
      expect(exclusionRuleKind(value), value).toBeUndefined();
    }
  });
});

describe('ExclusionRuleSchema', () => {
  it('lower-cases and trims so the stored value matches what the matcher sees', () => {
    const parsed = ExclusionRuleSchema.parse({ value: '  Home.Example.COM  ', note: ' desk ' });
    expect(parsed.value).toBe('home.example.com');
    expect(parsed.note).toBe('desk');
  });

  it('defaults the note to empty', () => {
    expect(ExclusionRuleSchema.parse({ value: '192.0.2.1' }).note).toBe('');
  });

  it('rejects a value that is neither an address nor a hostname', () => {
    expect(ExclusionRuleSchema.safeParse({ value: 'not a host' }).success).toBe(false);
    expect(ExclusionRuleSchema.safeParse({ value: '' }).success).toBe(false);
  });
});

describe('ExclusionSettingsSchema', () => {
  it('accepts an empty list — that is exclusion switched off', () => {
    expect(ExclusionSettingsSchema.parse({ rules: [] }).rules).toEqual([]);
  });

  it('bounds the list so the per-request scan stays short', () => {
    const rules = Array.from({ length: MAX_EXCLUSION_RULES + 1 }, (_, i) => ({
      value: `10.0.0.${i % 256}`,
    }));
    expect(ExclusionSettingsSchema.safeParse({ rules }).success).toBe(false);
  });
});
