import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

/** A real server on its own throwaway database, booted but not yet claimed. */
export interface Server {
  baseURL: string;
  /** The first-run token the server logged — spent by whoever claims the admin. */
  setupToken: string;
  /** The temp directory holding the database; gone after `stop`. */
  dir: string;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const server = await startServer({ seed: true });
  const storageState = join(server.dir, 'state.json');
  try {
    // Claim the admin through the real route, so the setup flow is exercised
    // rather than faked, and keep the session it hands back.
    const api = await request.newContext({ baseURL: server.baseURL });
    const claimed = await api.post('/api/admin/setup', {
      data: { password: SETUP_PASSWORD, setupToken: server.setupToken },
    });
    if (!claimed.ok()) {
      throw new Error(`setup refused: ${claimed.status()} ${await claimed.text()}`);
    }
    await api.storageState({ path: storageState });
    await api.dispose();
  } catch (failure) {
    await server.stop();
    throw failure;
  }
  return { baseURL: server.baseURL, storageState, stop: server.stop };
}

/**
 * Boots the server over a new database: seeded for the shared harness, empty
 * for a spec that needs an instance nobody has set up yet.
 */
export async function startServer({ seed }: { seed: boolean }): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), 'featherstat-e2e-'));
  const dbPath = join(dir, 'e2e.db');

  if (seed) run('bun', ['run', '--cwd', 'apps/server', 'seed'], { DB_PATH: dbPath });

  const server = spawn(
    'node',
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', 'src/main.ts'],
    {
      cwd: join(ROOT, 'apps/server'),
      env: {
        ...process.env,
        DB_PATH: dbPath,
        WEB_DIR: join(ROOT, 'apps/web/dist'),
        // The OS picks; the server logs what it bound, so nothing can race for it.
        PORT: '0',
        // A test run must never reach for a few hundred MB of GeoIP database.
        GEOIP_AUTO: '0',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const stop = async (): Promise<void> => {
    // A server that died during boot has no exit left to wait for.
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const { setupToken, port } = await boot(server);
    return { baseURL: `http://127.0.0.1:${port}`, setupToken, dir, stop };
  } catch (failure) {
    await stop();
    throw failure;
  }
}

/** Resolves once the server has logged both the token and the port it bound. */
function boot(server: ReturnType<typeof spawn>): Promise<{ setupToken: string; port: number }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let token: string | undefined;
    let port: number | undefined;
    const timer = setTimeout(() => {
      reject(new Error(`server did not boot in ${BOOT_TIMEOUT_MS}ms:\n${output}`));
    }, BOOT_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else if (token === undefined) reject(new Error(`no setup token logged:\n${output}`));
      else if (port === undefined) reject(new Error(`no port logged:\n${output}`));
      else resolve({ setupToken: token, port });
    };
    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      token ??= TOKEN_LINE.exec(output)?.[1];
      const listening = LISTENING.exec(output)?.[1];
      if (listening !== undefined) {
        port = Number(listening);
        finish();
      }
    };
    server.stdout?.on('data', read);
    server.stderr?.on('data', read);
    server.once('exit', (code) => finish(new Error(`server exited (${code}):\n${output}`)));
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
