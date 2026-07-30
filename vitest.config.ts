import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because exactly one of them needs a Svelte compiler and a DOM.
 *
 * `node` is everything that is plain TypeScript — the server, the shared
 * vocabulary, the tracker, the web's pure derivations, and the cross-package
 * contract suite at `test/contract` (see CLAUDE.md § Conventions for why that
 * one does not sit beside the code it tests).
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
          alias: {
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
          ],
          exclude: ['**/node_modules/**', '**/*.dom.test.ts'],
        },
      },
      './apps/web',
    ],
  },
});
