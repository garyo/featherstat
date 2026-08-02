import {
  type AlertRule,
  AlertRulesSchema,
  type FilterNode,
  isQueryError,
  type QueryRequest,
  type QueryResponse,
} from '@featherstat/shared';
import { type Db, getSetting, getSite, setSetting } from '../db/index.ts';
import type { NtfyNotifier } from '../notify/ntfy.ts';
import { executeQueryRequest } from '../query/executor.ts';

/**
 * Hourly alert evaluation (docs/04 § 5): each stored rule runs one small
 * query batch through the ordinary executor — the same vocabulary, scoping and
 * refusal semantics as every dashboard — and a breach posts through the ntfy
 * notifier under a per-rule cooldown key, so a condition that stays breached
 * repeats at most once per cooldown, not once per hourly run.
 *
 * Rules live in ONE settings row (`alert_rules`, a JSON array capped by the
 * shared schema), mirroring how the ntfy hit rules are stored: validated on
 * write by the admin route, re-parsed on read, failing closed to no alerts
 * rather than wrong ones.
 */

export const ALERT_RULES_KEY = 'alert_rules';

/** A breached rule renotifies at most this often while it stays breached. */
export const ALERT_COOLDOWN_MS = 6 * 3_600_000;

/** What `runAlerts`/`runDigest` need from the notifier — main.ts passes the real one. */
export type AlertNotifier = Pick<NtfyNotifier, 'post' | 'configured'>;

/** A row we cannot validate disables alerts rather than firing wrong ones. */
export function readAlertRules(db: Db, warn: (line: string) => void = console.warn): AlertRule[] {
  const raw = getSetting(db, ALERT_RULES_KEY);
  if (raw === undefined) return [];
  try {
    const parsed = AlertRulesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    warn(`${ALERT_RULES_KEY} is not a valid rule list — alerts are off`);
  } catch {
    warn(`${ALERT_RULES_KEY} is not valid JSON — alerts are off`);
  }
  return [];
}

/** Runs inside the caller's write transaction (docs/02 single writer). */
export function writeAlertRules(db: Db, rules: readonly AlertRule[]): void {
  setSetting(db, ALERT_RULES_KEY, JSON.stringify(rules));
}

export interface AlertsOptions {
  now?: () => number;
  /** Injectable for tests; defaults to the in-process executor. */
  execute?: (request: QueryRequest, now: number) => QueryResponse;
}

export interface AlertsResult {
  evaluated: number;
  fired: number;
  /** ntfy is unconfigured — nothing was evaluated at all. */
  skipped: boolean;
}

export function runAlerts(
  db: Db,
  notify: AlertNotifier,
  options: AlertsOptions = {},
): AlertsResult {
  if (!notify.configured()) return { evaluated: 0, fired: 0, skipped: true };
  const now = options.now?.() ?? Date.now();
  const execute =
    options.execute ?? ((request, at) => executeQueryRequest(db, request, { now: at }));
  const rules = readAlertRules(db);
  let fired = 0;
  for (const rule of rules) {
    const response = execute(requestOf(rule), now);
    const outcome = evaluateAlert(rule, response);
    if (outcome === undefined) continue;
    const siteName = getSite(db, rule.site)?.name ?? `site ${rule.site}`;
    if (
      notify.post(
        `alert:${ruleKey(rule)}`,
        `${siteName}: ${rule.metric} alert`,
        outcome,
        ALERT_COOLDOWN_MS,
      )
    ) {
      fired += 1;
    }
  }
  return { evaluated: rules.length, fired, skipped: false };
}

/**
 * One rule → one single-query batch: the metric over `today` (site-local day
 * so far) or the rolling `24h`, narrowed by an ordinary `eq` filter when the
 * rule names a dimension value, with `compare: 'previous'` exactly when the
 * condition needs a previous window.
 */
export function requestOf(rule: AlertRule): QueryRequest {
  const filters: FilterNode[] | undefined =
    rule.dim === undefined || rule.value === undefined
      ? undefined
      : [{ dim: rule.dim, op: 'eq', value: rule.value }];
  return {
    site: rule.site,
    range: { preset: rule.window === 'day' ? 'today' : '24h' },
    compare: rule.condition === 'delta_pct' ? 'previous' : undefined,
    queries: [
      { id: 'alert', metrics: [rule.metric], ...(filters === undefined ? {} : { filters }) },
    ],
  };
}

/**
 * The breach message, or undefined when the rule holds. A per-query refusal
 * (an unanswerable metric × dimension shape) evaluates to no alert — a rule
 * the vocabulary refuses must not page anyone with a made-up number.
 */
export function evaluateAlert(rule: AlertRule, response: QueryResponse): string | undefined {
  const entry = response.results.alert;
  if (entry === undefined || isQueryError(entry)) return undefined;
  const current = numberOf(entry.rows[0]?.[rule.metric]);
  const where = describeScope(rule);
  if (rule.condition === 'above') {
    return current !== null && current > rule.threshold
      ? `${rule.metric}${where} is ${current}, above ${rule.threshold} (${windowLabel(rule)})`
      : undefined;
  }
  if (rule.condition === 'below') {
    // No rows at all still reads as 0 for the count metrics' empty value — a
    // silent site is exactly what a 'below' rule exists to notice.
    return (current ?? 0) < rule.threshold
      ? `${rule.metric}${where} is ${current ?? 0}, below ${rule.threshold} (${windowLabel(rule)})`
      : undefined;
  }
  // delta_pct: the absolute percent change against the previous window. A
  // previous of zero (or an unmeasured ratio) has no percent to compare.
  const previous = numberOf(entry.compare?.[0]?.[rule.metric]);
  if (current === null || previous === null || previous === 0) return undefined;
  const pct = ((current - previous) / previous) * 100;
  return Math.abs(pct) >= rule.threshold
    ? `${rule.metric}${where} ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% ` +
        `(${previous} → ${current}, ${windowLabel(rule)})`
    : undefined;
}

function describeScope(rule: AlertRule): string {
  return rule.dim === undefined ? '' : ` for ${rule.dim}=${rule.value}`;
}

function windowLabel(rule: AlertRule): string {
  return rule.window === 'day' ? 'today so far' : 'last 24h';
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Stable across settings edits, so an unrelated rule change keeps cooldowns. */
function ruleKey(rule: AlertRule): string {
  return JSON.stringify([
    rule.site,
    rule.metric,
    rule.dim ?? null,
    rule.value ?? null,
    rule.condition,
    rule.threshold,
    rule.window,
  ]);
}
