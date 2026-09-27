import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // Order matters: the bare-specifier alias is a PREFIX match, so the
    // subpath must resolve first or it would land inside index.ts.
    alias: {
      '@featherstat/shared/detail-templates': fileURLToPath(
        new URL('../../packages/shared/src/templates/detail/index.ts', import.meta.url),
      ),
      '@featherstat/shared': fileURLToPath(
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
      // The claim POSTs; `/invite/<token>` is also the page, so its GET stays here.
      '/claim': process.env.API_PROXY ?? 'http://localhost:8080',
      '/invite': {
        target: process.env.API_PROXY ?? 'http://localhost:8080',
        bypass: (req) => (req.method === 'GET' ? '/index.html' : undefined),
      },
    },
  },
});
