import type { NtfyRule } from '@analytics/shared';
import { type Db, type EventRow, getSite } from '../db/index.ts';
import { type NtfySettings, readNtfySettings } from './settings.ts';

/**
 * ntfy notifications (docs/01 R16): the pipeline's `onHit` hook, matched against
 * the configured rules and POSTed to `<ntfy_url>/<ntfy_topic>`.
 *
 * Three properties this must never lose:
 * - **Ingest is never slowed**: matching is in-memory, delivery is deferred to a
 *   microtask, and nothing here is awaited by the caller.
 * - **The ntfy server is never flooded**: each rule fires at most once per
 *   cooldown, and the backlog is bounded (oldest dropped, counted not raised).
 * - **No visitor is identifiable** (CLAUDE.md invariant 3): the message is built
 *   from `titleOf`/`bodyOf` alone — site, event, page, city/country, site-local
 *   time. Never the IP, the visitor or session id, or a user id.
 */

export const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_PENDING = 32;
const DEFAULT_MAX_IN_FLIGHT = 2;
/** A hung ntfy must not hold an in-flight slot forever. */
const REQUEST_TIMEOUT_MS = 5_000;
/** A notification title is a glance, and it rides in a header. */
const MAX_TITLE_CHARS = 120;
/** What the settings pane's "send test" delivers — says what it is, carries no data. */
const TEST_TITLE = 'Analytics test notification';
const TEST_BODY = 'Notifications are configured. Matching hits will arrive here.';
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export interface NtfyRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** Injectable for tests; production passes global fetch. */
export type NtfyFetch = (url: string, init: NtfyRequestInit) => Promise<unknown>;

export interface NtfyNotifierOptions {
  fetchFn?: NtfyFetch;
  now?: () => number;
  /** Per-rule minimum spacing between notifications. */
  cooldownMs?: number;
  /** Queued deliveries beyond the in-flight ones; oldest dropped past this. */
  maxPending?: number;
  maxInFlight?: number;
  warn?: (line: string) => void;
}

export interface NtfyStats {
  sent: number;
  failed: number;
  /** Queued behind a full backlog and discarded. */
  dropped: number;
  /** Matched a rule still inside its cooldown. */
  suppressed: number;
  pending: number;
}

/** The settings pane's "send test" outcome — what ntfy said, never the token. */
export interface NtfyTestResult {
  ok: boolean;
  /** Nothing was attempted: the server url and topic are not configured yet. */
  unconfigured?: boolean;
  error?: string;
}

export interface NtfyNotifier {
  /** The pipeline `onHit` hook: synchronous, cheap when unconfigured, never throws. */
  record(event: EventRow): void;
  /** Re-reads the settings rows — the admin PUT calls this, no restart needed. */
  reload(): void;
  /** Delivers one notification now with the stored settings, and awaits the answer. */
  test(): Promise<NtfyTestResult>;
  stats(): NtfyStats;
}

interface Delivery {
  url: string;
  title: string;
  body: string;
  token?: string;
}

export function createNtfyNotifier(db: Db, options: NtfyNotifierOptions = {}): NtfyNotifier {
  const fetchFn = options.fetchFn ?? (fetch as NtfyFetch);
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const queue: Delivery[] = [];
  const firedAt = new Map<string, number>();
  let settings: NtfySettings = readNtfySettings(db, options.warn);
  let inFlight = 0;
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  let suppressed = 0;

  const pump = (): void => {
    while (inFlight < maxInFlight) {
      const delivery = queue.shift();
      if (delivery === undefined) return;
      inFlight += 1;
      // Deferred to a microtask so even a misbehaving fetch cannot stall ingest.
      Promise.resolve()
        .then(() => fetchFn(delivery.url, requestOf(delivery)))
        .then(
          (result) => {
            // An ntfy answering 403 (bad token) must not read as delivered.
            if (isNotOk(result)) failed += 1;
            else sent += 1;
          },
          () => {
            failed += 1;
          },
        )
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  };

  const record = (event: EventRow): void => {
    // Unconfigured is the common case: one array read, then out.
    if (settings.rules.length === 0) return;
    if (settings.url === undefined || settings.topic === undefined) return;
    // Pings are keep-alives, not things that happened (docs/04 § 4).
    if (event.type === 'ping') return;
    // One notification per hit: the first rule that matches owns it, including
    // its cooldown — overlapping rules must not multiply the traffic.
    const rule = settings.rules.find((candidate) => matches(candidate, event));
    if (rule === undefined) return;
    const key = ruleKey(rule);
    const last = firedAt.get(key);
    const at = now();
    if (last !== undefined && at - last < cooldownMs) {
      suppressed += 1;
      return;
    }
    firedAt.set(key, at);
    const siteName = getSite(db, event.site_id)?.name ?? `site ${event.site_id}`;
    const delivery: Delivery = {
      url: endpointOf(settings.url, settings.topic),
      title: titleOf(siteName, event),
      body: bodyOf(event),
    };
    if (settings.token !== undefined) delivery.token = settings.token;
    queue.push(delivery);
    while (queue.length > maxPending) {
      queue.shift();
      dropped += 1;
    }
    pump();
  };

  /**
   * Deliberately outside the queue and the cooldowns: an operator pressing the
   * button is asking what THIS request answers, not for a place in the backlog.
   * It is still one delivery, so it counts in the stats like any other.
   */
  const test = async (): Promise<NtfyTestResult> => {
    if (settings.url === undefined || settings.topic === undefined) {
      return { ok: false, unconfigured: true, error: 'set the ntfy server and topic first' };
    }
    const delivery: Delivery = {
      url: endpointOf(settings.url, settings.topic),
      title: TEST_TITLE,
      body: TEST_BODY,
    };
    if (settings.token !== undefined) delivery.token = settings.token;
    try {
      const result = await fetchFn(delivery.url, requestOf(delivery));
      if (isNotOk(result)) {
        failed += 1;
        return { ok: false, error: `the ntfy server refused it${statusOf(result)}` };
      }
      sent += 1;
      return { ok: true };
    } catch (cause) {
      failed += 1;
      return { ok: false, error: reasonOf(cause) };
    }
  };

  return {
    record,
    test,
    reload: () => {
      settings = readNtfySettings(db, options.warn);
      // Cooldowns of rules that no longer exist would leak; the rest keep theirs,
      // so re-saving the settings page cannot be used to bypass the spacing.
      const live = new Set(settings.rules.map(ruleKey));
      for (const key of firedAt.keys()) if (!live.has(key)) firedAt.delete(key);
    },
    stats: () => ({ sent, failed, dropped, suppressed, pending: queue.length + inFlight }),
  };
}

/** Every field the rule states must equal the event's; absent fields don't constrain. */
export function matches(rule: NtfyRule, event: EventRow): boolean {
  if (rule.site !== undefined && rule.site !== event.site_id) return false;
  if (rule.eventCategory !== undefined && rule.eventCategory !== event.event_category) return false;
  if (rule.eventAction !== undefined && rule.eventAction !== event.event_action) return false;
  if (rule.label !== undefined && rule.label !== event.event_name) return false;
  return true;
}

/** Stable across reloads, so cooldowns survive an unrelated settings edit. */
function ruleKey(rule: NtfyRule): string {
  return JSON.stringify([rule.site ?? null, rule.eventCategory, rule.eventAction, rule.label]);
}

function endpointOf(url: string, topic: string): string {
  return `${url.replace(/\/+$/, '')}/${topic}`;
}

function requestOf(delivery: Delivery): NtfyRequestInit {
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: headerValue(delivery.title),
  };
  if (delivery.token !== undefined) headers.Authorization = `Bearer ${delivery.token}`;
  return {
    method: 'POST',
    headers,
    body: delivery.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

/** 'packzen signup: account-created' — the site, then what happened. */
function titleOf(siteName: string, event: EventRow): string {
  const what = present(event.event_category) ? event.event_category : event.type;
  return present(event.event_action)
    ? `${siteName} ${what}: ${event.event_action}`
    : `${siteName} ${what}`;
}

/**
 * Header values reach ntfy as latin-1 bytes and this one is built from caller
 * input (site name, event category/action): control characters become spaces —
 * so a title can never inject a header — the length is capped, and anything
 * non-ASCII travels as an RFC 2047 encoded word rather than as corrupted bytes.
 */
function headerValue(title: string): string {
  let clean = '';
  for (const char of title.slice(0, MAX_TITLE_CHARS)) {
    const code = char.codePointAt(0) ?? 0;
    clean += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return PRINTABLE_ASCII.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** Detail lines, all of them non-identifying: label, value, page, place, site-local time. */
function bodyOf(event: EventRow): string {
  const lines: string[] = [];
  if (present(event.event_name)) lines.push(event.event_name);
  if (event.event_value !== null && event.event_value !== undefined) {
    lines.push(`value ${event.event_value}`);
  }
  if (present(event.path)) lines.push(event.path);
  const place = [event.city, event.country].filter(present).join(', ');
  if (place !== '') lines.push(place);
  lines.push(`${event.local_date} ${String(event.local_hour).padStart(2, '0')}:00`);
  return lines.join('\n');
}

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

/** Duck-typed `Response.ok` check — injected test fetches return plain objects. */
function isNotOk(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    (result as { ok: unknown }).ok === false
  );
}

/** The status of a refusal, when the answer carried one — same duck-typing as `isNotOk`. */
function statusOf(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('status' in result)) return '';
  const status = (result as { status: unknown }).status;
  return typeof status === 'number' ? ` (HTTP ${status})` : '';
}

/** A failed fetch says something useful ('fetch failed', a timeout); keep it, add nothing. */
function reasonOf(cause: unknown): string {
  return cause instanceof Error && cause.message !== ''
    ? cause.message
    : 'the ntfy server could not be reached';
}
