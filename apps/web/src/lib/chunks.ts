/**
 * Every code-split chunk loads through here (docs/05 § What editability costs
 * names them: the editor, the share dialog, library management, Settings, the
 * detail views, the query modal).
 *
 * A deploy replaces the hashed bundle, so a tab left open across one asks for a
 * chunk the server no longer has. The import rejects — and every caller was a
 * `void import(…)`, so Share, Edit, Manage and the rest became buttons that did
 * nothing at all, with the reason only in the console. The page cannot recover
 * on its own: the build it is running is gone.
 *
 * Plain TypeScript, and the failure travels to a handler rather than to a rune
 * held here: `loadEditor` is imported by tests that run without a Svelte
 * compiler (vitest.config.ts § the two projects), and module-level rune state
 * would throw the moment one of them imported it.
 */

let onFailure: (() => void) | undefined;

/** The shell says what a dead chunk looks like; only it renders. */
export function onChunkFailure(handler: () => void): void {
  onFailure = handler;
}

/** The chunk, or undefined — the caller renders nothing and the shell speaks. */
export async function loadChunk<T>(chunk: () => Promise<T>): Promise<T | undefined> {
  try {
    return await chunk();
  } catch {
    onFailure?.();
    return undefined;
  }
}
