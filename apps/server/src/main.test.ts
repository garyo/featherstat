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
/** The line main.ts logs once it is bound, carrying the port the OS chose. */
const LISTENING = /listening on :(\d+)/;
const BOOT_TIMEOUT_MS = 15_000;

let child: ChildProcess;
let dataDir: string;
let base: string;

/**
 * Resolves with the bound port the moment the server logs it, and rejects as
 * soon as the child exits instead — a boot crash fails here with its own
 * output, not as a timeout. Both streams stay drained for the child's whole
 * life: a pipe nobody reads fills, and the server then blocks on its next log.
 */
function booted(server: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`server did not boot in ${BOOT_TIMEOUT_MS} ms:\n${output}`)));
    }, BOOT_TIMEOUT_MS);
    const read = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString();
      const port = LISTENING.exec(output)?.[1];
      if (port !== undefined) settle(() => resolve(Number(port)));
    };
    server.stdout?.on('data', read);
    server.stderr?.on('data', read);
    server.once('exit', (code, signal) => {
      settle(() => reject(new Error(`server exited (${code ?? signal}) at boot:\n${output}`)));
    });
  });
}

function exited(server: ChildProcess): Promise<number | null> {
  if (server.exitCode !== null || server.signalCode !== null) {
    return Promise.resolve(server.exitCode);
  }
  return new Promise((resolve) => server.once('exit', (code) => resolve(code)));
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
        PORT: '0',
        AUTH_DISABLED: '',
        METRICS_TOKEN: '',
        MATOMO_FORWARD_URL: '',
        GEOIP_AUTO: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  base = `http://127.0.0.1:${await booted(child)}`;
}, 30_000);

afterAll(async () => {
  // The SIGTERM test below normally stops it; this covers a run that failed first.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await exited(child);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the built entrypoint serves the SECURED app', () => {
  it('401s every dashboard read without a session', async () => {
    const query = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site: 1,
        range: { preset: '7d' },
        queries: [{ id: 'k', metrics: ['pageviews'] }],
      }),
    });
    expect(query.status).toBe(401);
    expect((await fetch(`${base}/api/sites`)).status).toBe(401);
    expect((await fetch(`${base}/api/realtime?sites=all`)).status).toBe(401);
  });

  it('mounts the admin API (login is possible) and keeps setup token-gated', async () => {
    const me = await fetch(`${base}/api/admin/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ authenticated: false, needsSetup: true });

    const setup = await fetch(`${base}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-decent-password', setupToken: 'not-the-real-token' }),
    });
    expect(setup.status).toBe(403); // the real token only exists in the server log
  });

  it('mounts dashboards and notifications gated, share links public but unguessable', async () => {
    expect((await fetch(`${base}/api/admin/dashboards`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/ntfy`)).status).toBe(401);
    // Exclusion rules are the operator's own addresses — gated like the rest,
    // and mounted at all only because main.ts hands the route the live matcher.
    expect((await fetch(`${base}/api/admin/exclusions`)).status).toBe(401);
    // Public prefix, but a token nobody minted resolves to nothing.
    const share = await fetch(`${base}/share/${'a'.repeat(43)}`);
    expect(share.status).toBe(404);
    expect(share.headers.get('content-type')).toContain('application/json');
  });

  it('keeps tracking public and 404s unconfigured /metrics', async () => {
    const beacon = await fetch(`${base}/matomo.php?idsite=1&rec=1&send_image=0`);
    expect(beacon.status).toBe(204);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});

// Last on purpose: it stops the server the tests above share.
describe('the built entrypoint on SIGTERM', () => {
  it('flushes, drains, and exits 0 well inside a container stop grace', async () => {
    const exit = exited(child);
    const started = performance.now();
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 15_000);
});
