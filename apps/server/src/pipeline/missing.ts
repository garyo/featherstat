import { type Hit, type LocalClock, MISSING_PROP } from '@featherstat/shared';
import type { MissingRow, Site } from '../db/index.ts';
import type { DeviceInfo } from './enrich.ts';
import type { GeoResult } from './geo.ts';
import { type DomainOwners, referrerAttribution } from './referrers.ts';

/** A stored path is the received one cut to this — the tracker snippet sends at most 200. */
const MAX_PATH_CHARS = 200;

/**
 * A page view whose reserved `missing` prop is set is a not-found hit (docs/03
 * § Not-found hits): the site's 404 page announcing itself the way docs/10 § 3
 * says. Only the native tracker can say so — the Matomo shim carries no props.
 */
export function isMissingHit(hit: Hit): boolean {
  return hit.type === 'pageview' && Boolean(hit.props?.[MISSING_PROP]);
}

/** The prop's value as the stored path asked for: null when it is not a usable path. */
export function requestedPath(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_PATH_CHARS) : null;
}

export interface MissingInput {
  site: Site;
  /** Whose each referring host is, across every site (docs/03 § Attribution). */
  owners: DomainOwners;
  hit: Hit;
  now: number;
  local: LocalClock;
  device: DeviceInfo;
  geo: GeoResult | null;
}

/**
 * The row a not-found hit stores. Its referrer is the hit's OWN, never a visit's
 * first touch — a not-found hit belongs to no visit — and keeps the referring
 * page's path, which is what says where the broken link is.
 */
export function missingRow(input: MissingInput): MissingRow {
  const { site, hit, now, local, device, geo } = input;
  const ref = referrerAttribution(
    hit.referrer,
    { siteId: site.id, owners: input.owners },
    hostOf(hit.url),
  );
  return {
    site_id: site.id,
    ts: now,
    local_date: local.date,
    local_hour: local.hour,
    path: requestedPath(hit.props?.[MISSING_PROP]),
    ref_type: ref.ref_type ?? 'direct',
    ref_domain: ref.ref_domain,
    ref_path: ref.ref_type === undefined ? null : pathOf(hit.referrer),
    device_type: device.device_type,
    country: geo?.country ?? null,
  };
}

function hostOf(url: string | undefined): string | null {
  return parsed(url)?.hostname ?? null;
}

function pathOf(url: string | undefined): string | null {
  return parsed(url)?.pathname.slice(0, MAX_PATH_CHARS) ?? null;
}

function parsed(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
