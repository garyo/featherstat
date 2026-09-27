import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
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
