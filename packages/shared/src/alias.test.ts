import { describe, expect, it } from 'vitest';
import { ALIAS_ADJECTIVES, ALIAS_ANIMALS, ALIAS_COLOR_COUNT, aliasFromDigest } from './alias.ts';

const digest = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

describe('alias word lists', () => {
  it('hold 96 curated words each, capitalized and letter-only', () => {
    for (const list of [ALIAS_ADJECTIVES, ALIAS_ANIMALS]) {
      expect(list).toHaveLength(96);
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('pair by initial, so any same-group adjective + animal alliterate', () => {
    ALIAS_ADJECTIVES.forEach((adjective, i) => {
      expect(ALIAS_ANIMALS[i]?.[0], `entry ${i}`).toBe(adjective[0]);
    });
  });
});

describe('aliasFromDigest', () => {
  it('is deterministic and shaped like a two-word name with a palette color', () => {
    const alias = aliasFromDigest(digest(0, 0, 0));
    expect(alias).toEqual({ name: 'Amiable Aardvark', color: 0 });
    expect(aliasFromDigest(digest(0, 0, 0))).toEqual(alias);
  });

  it('alliterates for every digest, with the color inside the token range', () => {
    for (let i = 0; i < 64; i += 1) {
      const { name, color } = aliasFromDigest(digest(i * 5, i * 3, i * 7));
      const [adjective, animal] = name.split(' ');
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(adjective?.[0]).toBe(animal?.[0]);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThan(ALIAS_COLOR_COUNT);
    }
  });

  it('keys the color to the name — a collided name can never show two colors', () => {
    // Same first three bytes, wildly different tails: same alias either way.
    expect(aliasFromDigest(digest(7, 1, 0, 200, 13))).toEqual(aliasFromDigest(digest(7, 1, 0)));
  });

  it('spreads distinct visitors across many names', () => {
    const names = new Set<string>();
    for (let i = 0; i < 96; i += 1) names.add(aliasFromDigest(digest(i, i >> 1, i >> 2)).name);
    expect(names.size).toBeGreaterThan(20);
  });
});
