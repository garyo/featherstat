import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * The project that can RENDER — one of the two the root config runs.
 *
 * Mounting a component needs the Svelte compiler and a DOM, and both are local
 * to this workspace (`@sveltejs/vite-plugin-svelte` and `svelte` install here,
 * not at the root, so the root config cannot import them). The split is also
 * what keeps the compiler off the plain-TypeScript tests: `.svelte.ts` modules
 * would otherwise be compiled here and stubbed there, and a rune would mean two
 * different things depending on which file imported it.
 *
 * `*.dom.test.ts` — the extension is the contract with the root config's
 * exclude, so a test either renders or it doesn't, visibly, in its own name.
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      '@featherstat/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
    // Without this, `svelte` resolves to its server build and `mount()` throws:
    // vitest transforms through the SSR pipeline even when the environment is a DOM.
    conditions: ['browser'],
  },
  ssr: { resolve: { conditions: ['browser'] } },
  test: {
    name: 'dom',
    include: ['src/**/*.dom.test.ts'],
    environment: 'happy-dom',
  },
});
