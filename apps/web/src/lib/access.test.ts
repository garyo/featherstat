import { describe, expect, it } from 'vitest';
import { emptyScope, scopeLabel, scopeOf, toggleSite } from './access.ts';

describe('scopeOf', () => {
  it("answers 'all', a sorted list, or undefined while nothing is checked", () => {
    expect(scopeOf(emptyScope())).toBe('all');
    expect(scopeOf({ all: false, sites: [3, 1] })).toEqual([1, 3]);
    expect(scopeOf({ all: false, sites: [] })).toBeUndefined();
  });
});

describe('toggleSite', () => {
  it('adds and removes without mutating', () => {
    const sites = [1, 2];
    expect(toggleSite(sites, 3)).toEqual([1, 2, 3]);
    expect(toggleSite(sites, 1)).toEqual([2]);
    expect(sites).toEqual([1, 2]);
  });
});

describe('scopeLabel', () => {
  it('names what a principal can read', () => {
    const nameOf = (id: number): string => `Site ${id}`;
    expect(scopeLabel('all', nameOf)).toBe('all sites');
    expect(scopeLabel([2, 5], nameOf)).toBe('Site 2, Site 5');
  });
});
