import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from '@playwright/test';

/**
 * One production-like process for the whole run: the built SPA served by the
 * real server, over a freshly seeded throwaway database.
 *
 * Not vite plus a proxy. `WEB_DIR` (auth/app.ts) is how the container serves the
 * SPA in production, so pointing it at `apps/web/dist` tests the thing that
 * ships — including the SPA fallback and the auth gate in front of it, neither
 * of which exists under the dev proxy.
 *
 * Nothing here reaches for `data/dev.db`. The database is a temp directory
 * created per run and deleted after, so a suite run can never cost someone
 * their local data — and two runs in a row are identical, because the seed is.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SETUP_PASSWORD = 'e2e-password-not-a-secret';
/** The line `auth.ts` logs once on a database with no admin yet. */
const TOKEN_LINE = /first-run setup token: ([0-9a-f]+)/;
const LISTENING = /listening on :(\d+)/;
const BOOT_TIMEOUT_MS = 60_000;

export interface Harness {
  baseURL: string;
  storageState: string;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'featherstat-e2e-'));
  const dbPath = join(dir, 'e2e.db');
  const storageState = join(dir, 'state.json');

  run('bun', ['run', '--cwd', 'apps/server', 'seed'], { DB_PATH: dbPath });

  const port = await freePort();
  const server = spawn(
    'node',
    [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      '--import',
      './test/replay/shared-alias.ts',
      'src/main.ts',
    ],
    {
      cwd: join(ROOT, 'apps/server'),
      env: {
        ...process.env,
        DB_PATH: dbPath,
        WEB_DIR: join(ROOT, 'apps/web/dist'),
        PORT: String(port),
        // A test run must never reach for a few hundred MB of GeoIP database.
        GEOIP_AUTO: '0',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const baseURL = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const token = await bootToken(server);
    // Claim the admin through the real route, so the setup flow is exercised
    // rather than faked, and keep the session it hands back.
    const api = await request.newContext({ baseURL });
    const claimed = await api.post('/api/admin/setup', {
      data: { password: SETUP_PASSWORD, setupToken: token },
    });
    if (!claimed.ok()) {
      throw new Error(`setup refused: ${claimed.status()} ${await claimed.text()}`);
    }
    await api.storageState({ path: storageState });
    await api.dispose();
  } catch (failure) {
    await stop();
    throw failure;
  }

  return { baseURL, storageState, stop };
}

/** Resolves once the server has logged both the token and its port. */
function bootToken(server: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let token: string | undefined;
    const timer = setTimeout(() => {
      reject(new Error(`server did not boot in ${BOOT_TIMEOUT_MS}ms:\n${output}`));
    }, BOOT_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else if (token === undefined) reject(new Error(`no setup token logged:\n${output}`));
      else resolve(token);
    };
    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      token ??= TOKEN_LINE.exec(output)?.[1];
      if (LISTENING.test(output)) finish();
    };
    server.stdout?.on('data', read);
    server.stderr?.on('data', read);
    server.once('exit', (code) => finish(new Error(`server exited (${code}):\n${output}`)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not take a port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function run(command: string, args: readonly string[], env: Record<string, string>): void {
  const done = spawnSync(command, [...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${done.stdout}\n${done.stderr}`);
  }
}
