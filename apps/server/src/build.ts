import { build } from 'esbuild';

/**
 * Bundles the server's entry points into `dist/`, one self-contained ESM file
 * each, for the image to run with plain `node`. `bun run build` in this
 * workspace runs it.
 *
 * better-sqlite3 stays external: it is a native module, rebuilt against the
 * runtime image and copied in beside the bundles (Dockerfile, native stage).
 * The banner gives the ESM bundle the `require` its CommonJS dependencies call.
 */
const ENTRIES = {
  main: 'src/main.ts',
  import: 'src/import/cli.ts',
  'geoip-refresh': 'src/jobs/geoip-refresh-cli.ts',
  // main.ts spawns this one by name, beside itself.
  'query-worker': 'src/query/pool/worker.ts',
};

await build({
  entryPoints: ENTRIES,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['better-sqlite3'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
