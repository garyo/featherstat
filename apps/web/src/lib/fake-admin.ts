import { flushSync } from 'svelte';
import { type AdminClient, createAdminClient } from './admin.ts';

/**
 * A real `AdminClient` over a scripted server, for the DOM tests that mount a
 * settings panel or dialog: the component goes through the same client, the
 * same error mapping and the same JSON as in the app, and only `fetch` is fake.
 *
 * Routes are keyed `METHOD /path` (query string included). A handler gets the
 * parsed body and answers with a value (200 JSON), a `Response`, or a promise of
 * either — which is how a test holds a request open. An unscripted route is a
 * 404, so a request nobody expected fails loudly instead of hanging.
 */
export type FakeRoute = (body: unknown) => unknown;

export interface FakeCall {
  route: string;
  body: unknown;
}

export function fakeAdmin(routes: Record<string, FakeRoute>): {
  admin: AdminClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = `${init?.method ?? 'GET'} ${String(input)}`;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ route, body });
    const handler = routes[route];
    if (handler === undefined) return json(404, { error: `unscripted: ${route}` });
    const answer = await handler(body);
    return answer instanceof Response ? answer : json(200, answer ?? { ok: true });
  }) as typeof fetch;
  return { admin: createAdminClient({ fetch: fetchImpl }), calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A request the test answers when it chooses — the way to stage a race. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every pending fetch and effect run, then renders. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
  flushSync();
}

/** The button whose text is exactly `label` — what a reader would click. */
export function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button labelled "${label}"`);
  return found;
}
