import type { Dashboard } from '../../index.ts';
import { campaignDetail } from './campaign.ts';
import type { DetailDimension } from './dims.ts';
import { pageDetail } from './page.ts';
import { referrerDetail } from './referrer.ts';

/**
 * The entity detail templates (docs/05 § Detail views), keyed by the dimension
 * a drill starts from. Code, never stored rows and never in the dashboard
 * library: a detail view is versionless — it builds at the current vocabulary
 * on every visit, exactly like a shipped template, but it belongs to an entity
 * rather than to a scope, so it has no `t:<id>` ref and nothing to clone.
 */
export interface DetailTemplate {
  dim: DetailDimension;
  /** Heading noun for the view chrome ("Page", "Referrer", "Campaign"). */
  label: string;
  build(site: number, value: string): Dashboard;
}

export const DETAIL_TEMPLATES: Record<DetailDimension, DetailTemplate> = {
  path: { dim: 'path', label: 'Page', build: pageDetail },
  ref_domain: { dim: 'ref_domain', label: 'Referrer', build: referrerDetail },
  utm_campaign: { dim: 'utm_campaign', label: 'Campaign', build: campaignDetail },
};

export { campaignDetail, pageDetail, referrerDetail };
