import {
  type AlertCondition,
  type AlertRule,
  type AlertWindow,
  BaseDimensionSchema,
  MetricSchema,
} from '@featherstat/shared';

/**
 * The pure half of the alert-rules pane (docs/04 § 5): the all-strings shape
 * the rows edit, the rule list a save PUTs, and the first refusal routed to the
 * row that caused it. The server re-validates everything; this module's job is
 * to send the shape it asked for.
 */

export interface AlertDraft {
  /** Site id as text — a select over the directory fills it. */
  site: string;
  metric: string;
  /** '' = the rule watches the site total, not one dimension value. */
  dim: string;
  value: string;
  condition: AlertCondition;
  threshold: string;
  window: AlertWindow;
}

export function emptyAlert(siteId?: number): AlertDraft {
  return {
    site: siteId === undefined ? '' : String(siteId),
    metric: 'visits',
    dim: '',
    value: '',
    condition: 'above',
    threshold: '',
    window: 'day',
  };
}

export function draftsOf(rules: readonly AlertRule[]): AlertDraft[] {
  return rules.map((rule) => ({
    site: String(rule.site),
    metric: rule.metric,
    dim: rule.dim ?? '',
    value: rule.value ?? '',
    condition: rule.condition,
    threshold: String(rule.threshold),
    window: rule.window,
  }));
}

/** All drafts as wire rules, or the first row-indexed refusal. */
export function rulesOf(
  drafts: readonly AlertDraft[],
): { rules: AlertRule[] } | { error: string; row: number } {
  const rules: AlertRule[] = [];
  for (const [row, draft] of drafts.entries()) {
    const site = Number(draft.site);
    if (!Number.isInteger(site) || site <= 0) return { error: 'pick a site', row };
    const threshold = Number(draft.threshold);
    if (draft.threshold.trim() === '' || !Number.isFinite(threshold)) {
      return { error: 'the threshold must be a number', row };
    }
    const metric = MetricSchema.safeParse(draft.metric);
    if (!metric.success) return { error: `'${draft.metric}' is not a metric`, row };
    const rule: AlertRule = {
      site,
      metric: metric.data,
      condition: draft.condition,
      threshold,
      window: draft.window,
    };
    const dim = draft.dim.trim();
    const value = draft.value.trim();
    if ((dim === '') !== (value === '')) {
      return { error: 'a dimension and its value come together', row };
    }
    if (dim !== '') {
      const parsed = BaseDimensionSchema.safeParse(dim);
      if (!parsed.success) return { error: `'${dim}' is not a dimension`, row };
      rule.dim = parsed.data;
      rule.value = value;
    }
    rules.push(rule);
  }
  return { rules };
}

/** What a rule's comparison reads as in a list row. */
export function describeCondition(rule: AlertRule): string {
  const which = rule.condition === 'delta_pct' ? 'moves more than' : rule.condition;
  const unit = rule.condition === 'delta_pct' ? '%' : '';
  return `${which} ${rule.threshold}${unit} (${rule.window === 'day' ? 'today' : 'last 24h'})`;
}
