import { canonicalUtmValue } from '@featherstat/shared';

/**
 * The UTM link builder's pure half: compose a landing URL with utm params, and
 * say — before anyone pastes the link anywhere — which values ingest would
 * store differently than typed (docs/03 § Campaigns: trim, collapse internal
 * whitespace, lowercase, then alias lookup). Client-only convenience; the
 * server never sees these drafts.
 */

export interface UtmDraft {
  /** Bare domain or full URL; a missing scheme reads as https. */
  domain: string;
  path: string;
  campaign: string;
  source: string;
  medium: string;
}

export function emptyUtmDraft(domain = ''): UtmDraft {
  return { domain, path: '/', campaign: '', source: '', medium: '' };
}

const UTM_FIELDS = [
  ['utm_campaign', 'campaign'],
  ['utm_source', 'source'],
  ['utm_medium', 'medium'],
] as const;

/** The tagged URL, or undefined until domain + campaign + source are present. */
export function buildUtmUrl(draft: UtmDraft): string | undefined {
  const domain = draft.domain.trim();
  if (domain === '' || draft.campaign.trim() === '' || draft.source.trim() === '') {
    return undefined;
  }
  let base: URL;
  try {
    base = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`);
  } catch {
    return undefined;
  }
  const path = draft.path.trim();
  base.pathname = path === '' ? '/' : path.startsWith('/') ? path : `/${path}`;
  for (const [param, field] of UTM_FIELDS) {
    const value = draft[field].trim();
    if (value !== '') base.searchParams.set(param, value);
  }
  return base.toString();
}

export interface UtmWarning {
  field: 'campaign' | 'source' | 'medium';
  /** What ingest will actually store for the typed value. */
  stored: string;
}

/** Fields whose typed value ingest would normalize into something else. */
export function normalizationWarnings(draft: UtmDraft): UtmWarning[] {
  const warnings: UtmWarning[] = [];
  for (const [, field] of UTM_FIELDS) {
    const typed = draft[field].trim();
    if (typed === '') continue;
    const stored = canonicalUtmValue(typed);
    if (stored !== typed) warnings.push({ field, stored });
  }
  return warnings;
}
