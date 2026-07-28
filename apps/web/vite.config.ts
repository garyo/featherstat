import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      '@analytics/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      '/api': process.env.API_PROXY ?? 'http://localhost:8080',
      '/matomo.php': process.env.API_PROXY ?? 'http://localhost:8080',
      // The share endpoint is JSON the share page fetches (src/lib/share.ts);
      // unproxied, the dev server would answer it with index.html.
      '/share': process.env.API_PROXY ?? 'http://localhost:8080',
    },
  },
});
