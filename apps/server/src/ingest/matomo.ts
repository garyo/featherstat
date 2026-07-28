import { type EventPayload, EventPayloadSchema, type Hit, HitSchema } from '@featherstat/shared';

/** One inbound tracking request: the query string plus, for POST, the raw body. */
export interface MatomoRequest {
  query: URLSearchParams;
  body?: string;
}

export interface ParsedMatomoRequest {
  hits: Hit[];
  /** `send_image=0` asks for an empty 204 instead of the tracking GIF (docs/04 § 1). */
  sendImage: boolean;
}

/**
 * Normalize a matomo.php request into hits. Never throws and never rejects a
 * request: anything unparseable simply yields fewer hits (CLAUDE.md invariant 4).
 */
export function parseMatomoRequest(request: MatomoRequest): ParsedMatomoRequest {
  const sets = paramSets(request);
  const hits: Hit[] = [];
  for (const params of sets) {
    const hit = parseHit(params);
    if (hit) hits.push(hit);
  }
  const sendImage = request.query.get('send_image') !== '0' && !sets.some(asksForNoImage);
  return { hits, sendImage };
}

function asksForNoImage(params: URLSearchParams): boolean {
  return params.get('send_image') === '0';
}

/**
 * Beacons lie about `Content-Type` (`sendBeacon` forces its own), so the body is
 * sniffed rather than trusted: JSON bulk format first, form-encoded otherwise.
 */
function paramSets(request: MatomoRequest): URLSearchParams[] {
  const body = request.body?.trim();
  if (!body) return [request.query];
  if (body.startsWith('{')) {
    const bulk = parseBulk(body);
    if (bulk) return bulk;
  }
  const merged = new URLSearchParams(request.query);
  for (const [key, value] of new URLSearchParams(body)) merged.set(key, value);
  return [merged];
}

/** Matomo's bulk format: `{"requests": ["?idsite=1&…", …]}`; other keys are ignored. */
function parseBulk(body: string): URLSearchParams[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { requests } = parsed as { requests?: unknown };
  if (!Array.isArray(requests)) return undefined;
  return requests
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => new URLSearchParams(entry.startsWith('?') ? entry.slice(1) : entry));
}

function parseHit(params: URLSearchParams): Hit | undefined {
  if (params.get('rec') !== '1') return undefined;

  const url = optional(HitSchema.shape.url, stripFragment(params.get('url')));
  const title = optional(HitSchema.shape.title, params.get('action_name'));
  const link = optional(HitSchema.shape.targetUrl, params.get('link'));
  const download = optional(HitSchema.shape.targetUrl, params.get('download'));
  const event = parseEvent(params);

  let type: Hit['type'] | undefined;
  let targetUrl: string | undefined;
  if (event) {
    type = 'event';
  } else if (link) {
    type = 'outlink';
    targetUrl = link;
  } else if (download) {
    type = 'download';
    targetUrl = download;
  } else if (params.get('ping') === '1') {
    type = 'ping';
  } else if (url !== undefined || title !== undefined) {
    type = 'pageview'; // Matomo records a pageview from `action_name` alone (docs/04)
  }
  if (!type) return undefined;

  const hit = HitSchema.safeParse({
    siteId: Number(params.get('idsite')),
    type,
    url,
    title,
    referrer: optional(HitSchema.shape.referrer, params.get('urlref')),
    targetUrl,
    event,
    screen: optional(HitSchema.shape.screen, params.get('res')),
    lang: optional(HitSchema.shape.lang, params.get('lang')),
    visitorId: optional(HitSchema.shape.visitorId, params.get('_id')?.toLowerCase()),
    uid: optional(HitSchema.shape.uid, params.get('uid')),
    // `cip` is carried but deliberately inert until an auth layer exists — an
    // unauthenticated override could spoof identity and geo (docs/04).
    clientIpOverride: optional(HitSchema.shape.clientIpOverride, params.get('cip')),
  });
  return hit.success ? hit.data : undefined;
}

/** An event needs both category and action; a half-declared one degrades to no event. */
function parseEvent(params: URLSearchParams): EventPayload | undefined {
  const rawValue = params.get('e_v');
  const event = EventPayloadSchema.safeParse({
    category: params.get('e_c') ?? undefined,
    action: params.get('e_a') ?? undefined,
    name: optional(EventPayloadSchema.shape.name, params.get('e_n')),
    value: optional(EventPayloadSchema.shape.value, rawValue ? Number(rawValue) : undefined),
  });
  return event.success ? event.data : undefined;
}

/** Query string is part of the page identity; the fragment never is (docs/04 § 1). */
function stripFragment(url: string | null): string | undefined {
  if (url === null) return undefined;
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Optional fields degrade one by one: a value the schema rejects is dropped, the hit kept. */
function optional<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: string | number | null | undefined,
): T | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
