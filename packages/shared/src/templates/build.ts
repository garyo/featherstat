import { type Dashboard, DashboardSchema } from '../index.ts';
import { upgradeDashboard } from '../layout.ts';

/**
 * Every template builds through here: parsed rather than cast so a shipped grid
 * can never drift from the schema user dashboards are validated against, and
 * carried forward by the same upgrade steps a stored layout is — the discipline
 * the original shipped defaults established (docs/05 § Layout versions).
 */
export function buildDashboard(raw: unknown): Dashboard {
  return upgradeDashboard(DashboardSchema.parse(raw));
}
