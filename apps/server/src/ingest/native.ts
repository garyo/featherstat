import {
  type CollectHit,
  CollectHitSchema,
  CollectRequestSchema,
  EventPayloadSchema,
  type Hit,
  HitSchema,
  MAX_COLLECT_HITS,
} from '@featherstat/shared';

/**
 * Normalize a `POST /api/collect` body into hits (docs/04 § 2).
 *
 * The sibling of `matomo.ts`, under the same contract: never throws and never
 * rejects a request. Anything unparseable simply yields fewer hits, because a
 * beacon must never bounce (CLAUDE.md invariant 4). The degradation is per hit
 * rather than per request — one bad entry in a batch costs itself alone.
 */
export function parseCollectRequest(body: string | undefined): Hit[] {
  const envelope = parseEnvelope(body);
  if (envelope === undefined) return [];
  const { site, hits: raw } = envelope;
  const hits: Hit[] = [];
  // Truncated, not refused: the hits that fit are still real (invariant 4).
  for (const entry of raw.slice(0, MAX_COLLECT_HITS)) {
    const hit = parseHit(site, entry);
    if (hit) hits.push(hit);
  }
  return hits;
}

function parseEnvelope(body: string | undefined): { site: number; hits: unknown[] } | undefined {
  const trimmed = body?.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const envelope = CollectRequestSchema.safeParse(parsed);
  return envelope.success ? envelope.data : undefined;
}

function parseHit(site: number, entry: unknown): Hit | undefined {
  const collected = CollectHitSchema.safeParse(entry);
  if (!collected.success) return undefined;
  const raw = collected.data;

  // A hit whose type promises a payload it did not bring says nothing: an event
  // with no category/action, or a destination-less outlink, is not a degraded
  // page view but an absence of news.
  const event = parseEvent(raw);
  if (raw.type === 'event' && event === undefined) return undefined;
  if ((raw.type === 'outlink' || raw.type === 'download') && raw.targetUrl === undefined) {
    return undefined;
  }

  const hit = HitSchema.safeParse({
    siteId: site,
    type: raw.type,
    url: stripFragment(raw.url),
    title: raw.title,
    referrer: raw.referrer,
    targetUrl: raw.targetUrl,
    event,
    screen: raw.screen,
    lang: raw.lang,
  });
  return hit.success ? hit.data : undefined;
}

/** An event needs both category and action; a half-declared one degrades to no event. */
function parseEvent(raw: CollectHit): Hit['event'] {
  const event = EventPayloadSchema.safeParse({
    category: raw.category,
    action: raw.action,
    name: raw.name,
    value: raw.value,
  });
  return event.success ? event.data : undefined;
}

/** Query string is part of the page identity; the fragment never is (docs/04 § 1). */
function stripFragment(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}
