import { describe, expect, it } from 'vitest';
import {
  ExclusionMatcher,
  formatAddress,
  parseAddress,
  parsePrefix,
  prefixContains,
  refreshResolutions,
} from './exclusions.ts';

const rule = (value: string) => ({ value, note: '' });

describe('parseAddress', () => {
  it('normalizes IPv4 into its mapped form', () => {
    const bytes = parseAddress('192.0.2.1');
    expect(bytes).toBeDefined();
    expect(formatAddress(bytes as Uint8Array)).toBe('192.0.2.1');
  });

  it('reads an IPv4-mapped IPv6 address as the same bytes as the bare IPv4', () => {
    expect(parseAddress('::ffff:192.0.2.1')).toEqual(parseAddress('192.0.2.1'));
  });

  it('expands :: compression', () => {
    expect(parseAddress('2001:db8::1')).toEqual(parseAddress('2001:db8:0:0:0:0:0:1'));
    expect(formatAddress(parseAddress('::1') as Uint8Array)).toBe('0:0:0:0:0:0:0:1');
  });

  it('ignores a link-local zone index', () => {
    expect(parseAddress('fe80::1%eth0')).toEqual(parseAddress('fe80::1'));
  });

  it('rejects malformed addresses', () => {
    for (const bad of [
      '',
      '192.0.2',
      '192.0.2.1.5',
      '192.0.2.256',
      '192.0.02.1', // leading zero reads as octal to some parsers — ambiguous, so refused
      '1.2.3.-1',
      '2001:db8::1::2',
      '2001:db8:0:0:0:0:0:0:1',
      'gggg::1',
      'not-an-address',
    ]) {
      expect(parseAddress(bad), bad).toBeUndefined();
    }
  });
});

describe('parsePrefix', () => {
  it('shifts an IPv4 prefix into mapped space', () => {
    expect(parsePrefix('192.0.2.0/24')?.bits).toBe(120);
    expect(parsePrefix('10.0.0.0/8')?.bits).toBe(104);
    expect(parsePrefix('0.0.0.0/0')?.bits).toBe(96);
  });

  it('leaves an IPv6 prefix alone and treats a bare address as a full-length one', () => {
    expect(parsePrefix('2001:db8::/32')?.bits).toBe(32);
    expect(parsePrefix('192.0.2.1')?.bits).toBe(128);
  });

  it('rejects a prefix wider than its family allows', () => {
    expect(parsePrefix('192.0.2.0/33')).toBeUndefined();
    expect(parsePrefix('2001:db8::/129')).toBeUndefined();
    expect(parsePrefix('192.0.2.0/-1')).toBeUndefined();
    expect(parsePrefix('192.0.2.0/abc')).toBeUndefined();
  });
});

describe('prefixContains', () => {
  it('matches inside a byte-aligned prefix and rejects outside it', () => {
    const prefix = parsePrefix('192.0.2.0/24');
    expect(prefixContains(prefix!, parseAddress('192.0.2.77')!)).toBe(true);
    expect(prefixContains(prefix!, parseAddress('192.0.3.77')!)).toBe(false);
  });

  it('honours the partial byte of a non-aligned prefix', () => {
    // /28 keeps the high nibble of the last octet: .16–.31 in, .32 out.
    const prefix = parsePrefix('192.0.2.16/28');
    expect(prefixContains(prefix!, parseAddress('192.0.2.16')!)).toBe(true);
    expect(prefixContains(prefix!, parseAddress('192.0.2.31')!)).toBe(true);
    expect(prefixContains(prefix!, parseAddress('192.0.2.32')!)).toBe(false);
    expect(prefixContains(prefix!, parseAddress('192.0.2.15')!)).toBe(false);
  });

  it('matches an IPv6 prefix', () => {
    const prefix = parsePrefix('2001:db8::/32');
    expect(prefixContains(prefix!, parseAddress('2001:db8:abcd::1')!)).toBe(true);
    expect(prefixContains(prefix!, parseAddress('2001:db9::1')!)).toBe(false);
  });
});

describe('ExclusionMatcher', () => {
  it('matches nothing while empty, without parsing the address', () => {
    const matcher = new ExclusionMatcher();
    expect(matcher.empty).toBe(true);
    expect(matcher.matches('192.0.2.1')).toBe(false);
  });

  it('matches a literal address and a CIDR rule', () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('192.0.2.1'), rule('198.51.100.0/24')]);
    expect(matcher.matches('192.0.2.1')).toBe(true);
    expect(matcher.matches('192.0.2.2')).toBe(false);
    expect(matcher.matches('198.51.100.200')).toBe(true);
    expect(matcher.matches('203.0.113.1')).toBe(false);
  });

  it('matches a v4 rule against a v4-mapped client address', () => {
    // Node hands back `::ffff:a.b.c.d` on a dual-stack socket; a rule typed as
    // plain IPv4 has to catch it or the filter silently misses on some hosts.
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('192.0.2.0/24')]);
    expect(matcher.matches('::ffff:192.0.2.5')).toBe(true);
  });

  it('ignores an unparseable rule rather than failing the whole set', () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('nonsense/999'), rule('192.0.2.1')]);
    expect(matcher.matches('192.0.2.1')).toBe(true);
  });

  it('never matches an unparseable client address', () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('0.0.0.0/0')]);
    expect(matcher.matches('')).toBe(false);
    expect(matcher.matches('garbage')).toBe(false);
  });

  it('matches a hostname rule once resolved, and not before', async () => {
    const matcher = new ExclusionMatcher(() => 1000);
    matcher.setRules([rule('home.example.com')]);
    expect(matcher.matches('192.0.2.9')).toBe(false);

    await refreshResolutions(matcher, async () => ['192.0.2.9', '2001:db8::9']);
    expect(matcher.matches('192.0.2.9')).toBe(true);
    expect(matcher.matches('2001:db8::9')).toBe(true);
    expect(matcher.matches('192.0.2.10')).toBe(false);
    expect(matcher.resolutions()).toEqual([
      {
        value: 'home.example.com',
        addresses: ['192.0.2.9', '2001:db8:0:0:0:0:0:9'],
        resolvedAt: 1000,
        error: null,
      },
    ]);
  });

  it('keeps the last known addresses when a lookup fails', async () => {
    const matcher = new ExclusionMatcher(() => 1000);
    matcher.setRules([rule('home.example.com')]);
    await refreshResolutions(matcher, async () => ['192.0.2.9']);
    await refreshResolutions(matcher, async () => {
      throw new Error('ENOTFOUND');
    });

    // A DNS blip must not re-admit the traffic the operator asked to drop.
    expect(matcher.matches('192.0.2.9')).toBe(true);
    const [resolution] = matcher.resolutions();
    expect(resolution?.error).toBe('ENOTFOUND');
    expect(resolution?.addresses).toEqual(['192.0.2.9']);
  });

  it('gives up on a resolver that never answers, and says so', async () => {
    // The live case this exists for: a Tailscale split-DNS route pointed the
    // name at a nameserver the server cannot reach, so the lookup did not fail
    // — it hung, and the admin save hung with it.
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('unreachable.example.com')]);
    const started = Date.now();
    await refreshResolutions(matcher, () => new Promise<string[]>(() => {}), 20);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(matcher.resolutions()[0]?.error).toBe('lookup timed out after 20 ms');
  });

  it('keeps the last known addresses when a lookup times out', async () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('home.example.com')]);
    await refreshResolutions(matcher, async () => ['192.0.2.9']);
    await refreshResolutions(matcher, () => new Promise<string[]>(() => {}), 20);
    expect(matcher.matches('192.0.2.9')).toBe(true);
  });

  it('follows a dynamic address from one lookup to the next', async () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('home.example.com')]);
    await refreshResolutions(matcher, async () => ['192.0.2.9']);
    await refreshResolutions(matcher, async () => ['198.51.100.4']);
    expect(matcher.matches('198.51.100.4')).toBe(true);
    expect(matcher.matches('192.0.2.9')).toBe(false);
  });

  it('caps how many addresses one hostname contributes', async () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('wide.example.com')]);
    const many = Array.from({ length: 40 }, (_, i) => `192.0.2.${i + 1}`);
    await refreshResolutions(matcher, async () => many);
    expect(matcher.resolutions()[0]?.addresses).toHaveLength(16);
  });

  it('keeps resolved state across a rule edit but forgets a removed hostname', async () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('home.example.com')]);
    await refreshResolutions(matcher, async () => ['192.0.2.9']);

    matcher.setRules([rule('home.example.com'), rule('10.0.0.0/8')]);
    expect(matcher.matches('192.0.2.9')).toBe(true); // survived the edit, no re-resolve needed

    matcher.setRules([rule('10.0.0.0/8')]);
    expect(matcher.matches('192.0.2.9')).toBe(false);
    expect(matcher.resolutions()).toEqual([]);
    expect(matcher.empty).toBe(false);
  });

  it('reports empty again once the rules are cleared', () => {
    const matcher = new ExclusionMatcher();
    matcher.setRules([rule('192.0.2.1')]);
    matcher.setRules([]);
    expect(matcher.empty).toBe(true);
  });
});
