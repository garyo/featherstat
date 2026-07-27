import { isbot } from 'isbot';
import { UAParser } from 'ua-parser-js';

export interface DeviceInfo {
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  device_type: 'desktop' | 'mobile' | 'tablet' | 'other';
}

/** Bots are dropped at the door and counted, never stored (docs/03 § Bots). */
export function isBotUserAgent(userAgent: string): boolean {
  return isbot(userAgent);
}

const UA_CACHE_MAX = 1024;
const uaCache = new Map<string, DeviceInfo>();

/** The same UA repeats constantly (docs/02), so parses sit behind a small LRU. */
export function parseUserAgent(userAgent: string): DeviceInfo {
  const cached = uaCache.get(userAgent);
  if (cached !== undefined) {
    uaCache.delete(userAgent);
    uaCache.set(userAgent, cached);
    return cached;
  }
  const result = new UAParser(userAgent).getResult();
  const info: DeviceInfo = {
    browser: result.browser.name ?? null,
    browser_version: result.browser.version ?? null,
    os: result.os.name ?? null,
    device_type: deviceType(result.device.type),
  };
  if (uaCache.size >= UA_CACHE_MAX) {
    const oldest = uaCache.keys().next().value;
    if (oldest !== undefined) uaCache.delete(oldest);
  }
  uaCache.set(userAgent, info);
  return info;
}

/** ua-parser leaves `device.type` undefined for desktop browsers. */
function deviceType(type: string | undefined): DeviceInfo['device_type'] {
  if (type === undefined) return 'desktop';
  if (type === 'mobile' || type === 'tablet') return type;
  return 'other';
}

/** The `Accept-Language` header is preferred over the tracker's `lang` param (docs/04). */
export function preferredLanguage(
  acceptLanguage: string | undefined,
  hitLang: string | undefined,
): string | null {
  const first = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim();
  const lang = first || hitLang;
  return lang ? lang.slice(0, 35) : null;
}
