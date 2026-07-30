import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isPermissive,
  licenseFindings,
  productionTree,
  unclassifiedDevDependencies,
  workspaceLicenseFindings,
} from './licenses.ts';

/**
 * featherstat is MIT and going public, so the licence of everything it ships has
 * to be an assertion rather than a memory (see `licenses.ts`).
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The tree is small and stable; a floor makes the assertions below impossible to
 * pass by walking nothing — the way a guard usually dies.
 */
const MIN_PRODUCTION_PACKAGES = 15;

describe('every dependency we ship is MIT-compatible', () => {
  it('walks a real, non-empty production tree', () => {
    const tree = productionTree(ROOT);
    expect(tree.length).toBeGreaterThanOrEqual(MIN_PRODUCTION_PACKAGES);
    // Named because CLAUDE.md names it: the v2 relicensing to AGPL is the trap
    // this gate replaces. If the dependency is gone, delete this line knowingly.
    expect(tree.map((installed) => installed.name)).toContain('ua-parser-js');
    // A transitive one, so the walk is proven to go deeper than the manifests.
    expect(tree.map((installed) => installed.name)).toContain('safer-buffer');
  });

  it('finds nothing incompatible', () => {
    expect(licenseFindings(ROOT)).toEqual([]);
  });

  it('has every workspace say MIT in its own manifest', () => {
    expect(workspaceLicenseFindings(ROOT)).toEqual([]);
  });

  it('leaves no devDependency unclassified as shipping or not', () => {
    expect(unclassifiedDevDependencies(ROOT)).toEqual([]);
  });
});

describe('the SPDX expressions this rests on', () => {
  it.each([
    ['MIT', true],
    ['Apache-2.0', true],
    ['(MIT OR Apache-2.0)', true],
    ['MIT AND ISC', true],
    ['Apache-2.0 WITH LLVM-exception', true],
    ['Unlicense', true],
    // The pair one careless `toLowerCase()` would merge: a public-domain
    // dedication and npm's marker for "proprietary, never publish".
    ['UNLICENSED', false],
    ['AGPL-3.0-or-later', false],
    ['GPL-3.0', false],
    ['(AGPL-3.0-or-later OR LicenseRef-commercial)', false],
    ['MIT AND GPL-3.0', false],
    ['SEE LICENSE IN LICENSE.md', false],
    ['', false],
  ])('reads %s as permissive=%s', (expression, permissive) => {
    expect(isPermissive(expression)).toBe(permissive);
  });
});
