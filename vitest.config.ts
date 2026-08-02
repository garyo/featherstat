import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because exactly one of them needs a Svelte compiler and a DOM.
 *
 * `node` is everything that is plain TypeScript — the server, the shared
 * vocabulary, the tracker, the web's pure derivations, and the two root suites
 * that legitimately cannot sit beside the code they test (see CLAUDE.md
 * § Conventions): `test/contract`, which tests the seam between two packages,
 * and `test/guards`, which tests the guards themselves — every one of which
 * lives in a different package.
 *
 * `apps/web` adds the Svelte plugin and happy-dom for `*.dom.test.ts`, the tests
 * that mount a component and read what it drew. It lives in that workspace
 * because the plugin does.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          // The subpath first: the bare-specifier alias is a prefix match.
          alias: {
            '@featherstat/shared/detail-templates': fileURLToPath(
              new URL('./packages/shared/src/templates/detail/index.ts', import.meta.url),
            ),
            '@featherstat/shared': fileURLToPath(
              new URL('./packages/shared/src/index.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'node',
          include: [
            'apps/*/src/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'test/contract/**/*.test.ts',
            'test/guards/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.dom.test.ts'],
        },
      },
      './apps/web',
    ],
  },
});
