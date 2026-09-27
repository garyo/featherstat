/** What a card needs to draw a read, whatever the read is keyed by. */
export interface LoadView<T> {
  /** The adopted answer; undefined while a new key loads, and after a failure. */
  readonly value: T | undefined;
  readonly failed: boolean;
  /** Reads the last key again — Retry, and the refresh after a mutation. */
  reload(): Promise<T | undefined>;
}

/**
 * One remote read a settings panel shows: loading, the answer, or a failure
 * that can be retried.
 *
 * Two things go wrong when a panel hand-rolls this. A failure flag nothing
 * clears leaves a list "unavailable" until the page reloads. And answers that
 * nothing orders let a card switched from site A to site B draw A's goals under
 * B when A's request comes back last. Here the newest call always wins, and
 * every call forgets the last failure.
 *
 * `K` is what the read is about (a site id); reads about nothing use `void`.
 */
export interface Loader<T, K = void> extends LoadView<T> {
  /**
   * Reads `key`, superseding any call still in flight. A new key blanks the old
   * answer at once — it is about something else; the same key keeps it on
   * screen until the fresh one lands. Resolves to what was adopted, or undefined
   * when this call failed or was overtaken.
   */
  load(key: K): Promise<T | undefined>;
  /** Adopts an answer a mutation already returned, overtaking any read in flight. */
  set(value: T): void;
}

export interface LoaderOptions<T> {
  /** Runs on every adopted answer — how a form reseeds its draft from what is stored. */
  onload?: (value: T) => void;
}

export function createLoader<T, K = void>(
  read: (key: K) => Promise<T>,
  options: LoaderOptions<T> = {},
): Loader<T, K> {
  let value = $state<T | undefined>(undefined);
  let failed = $state(false);
  let seq = 0;
  let last: { key: K } | undefined;

  function adopt(answer: T): T {
    value = answer;
    options.onload?.(answer);
    return answer;
  }

  async function load(key: K): Promise<T | undefined> {
    const mine = ++seq;
    if (last === undefined || last.key !== key) value = undefined;
    last = { key };
    failed = false;
    try {
      const answer = await read(key);
      return mine === seq ? adopt(answer) : undefined;
    } catch {
      if (mine === seq) {
        value = undefined;
        failed = true;
      }
      return undefined;
    }
  }

  return {
    get value() {
      return value;
    },
    get failed() {
      return failed;
    },
    load,
    reload: () => (last === undefined ? Promise.resolve(undefined) : load(last.key)),
    set(answer) {
      seq += 1;
      failed = false;
      adopt(answer);
    },
  };
}
