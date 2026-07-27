import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Boots the REAL production entrypoint (src/main.ts — the file the Docker
 * image runs) and probes its route matrix from outside. The in-process tests
 * of auth/app.test.ts cannot catch main.ts wiring the wrong app: that exact
 * regression once shipped every dashboard read unauthenticated.
 */

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18_000 + (process.pid % 20_000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
let dataDir: string;

async function up(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server never came up');
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'main-entry-'));
  child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      '--import',
      './test/replay/shared-alias.ts',
      'src/main.ts',
    ],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DB_PATH: join(dataDir, 'test.db'),
        PORT: String(PORT),
        AUTH_DISABLED: '',
        METRICS_TOKEN: '',
        MATOMO_FORWARD_URL: '',
        GEOIP_AUTO: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await up();
}, 30_000);

afterAll(() => {
  child.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the built entrypoint serves the SECURED app', () => {
  it('401s every dashboard read without a session', async () => {
    const query = await fetch(`${BASE}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site: 1,
        range: { preset: '7d' },
        queries: [{ id: 'k', metrics: ['pageviews'] }],
      }),
    });
    expect(query.status).toBe(401);
    expect((await fetch(`${BASE}/api/sites`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/realtime?sites=all`)).status).toBe(401);
  });

  it('mounts the admin API (login is possible) and keeps setup token-gated', async () => {
    const me = await fetch(`${BASE}/api/admin/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ authenticated: false, needsSetup: true });

    const setup = await fetch(`${BASE}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-decent-password', setupToken: 'not-the-real-token' }),
    });
    expect(setup.status).toBe(403); // the real token only exists in the server log
  });

  it('keeps tracking public and 404s unconfigured /metrics', async () => {
    const beacon = await fetch(`${BASE}/matomo.php?idsite=1&rec=1&send_image=0`);
    expect(beacon.status).toBe(204);
    expect((await fetch(`${BASE}/metrics`)).status).toBe(404);
  });
});
