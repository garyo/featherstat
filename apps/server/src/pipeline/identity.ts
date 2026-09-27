import { createHash, randomBytes } from 'node:crypto';
import { type Hit, type HitContext, localClock } from '@featherstat/shared';
import {
  type Db,
  deleteSetting,
  getSetting,
  listSites,
  setSetting,
  settingKeysWithPrefix,
  withWriteTransaction,
} from '../db/index.ts';

const DAY_SALT_PREFIX = 'salt:';
const UID_SALT_PREFIX = 'uidsalt:';
const UID_ENABLED_PREFIX = 'uid_enabled:';

/** Settings key that opts a site into `uid` hashing (value `'1'`; docs/03: off by default). */
export function uidEnabledKey(siteId: number): string {
  return UID_ENABLED_PREFIX + siteId;
}

function uidSaltKey(siteId: number): string {
  return UID_SALT_PREFIX + siteId;
}

/**
 * Site deletion companion — call inside the delete transaction, after the
 * tombstone. Drops the site's `uid` opt-in and salt and, when no live site is
 * left in its zone, the zone's day salts: rotation only ever runs on a hit, so
 * a zone nothing tracks would keep its last salt forever. True when the zone
 * was abandoned.
 */
export function forgetSiteIdentity(db: Db, siteId: number, timezone: string): boolean {
  deleteSetting(db, uidEnabledKey(siteId));
  deleteSetting(db, uidSaltKey(siteId));
  if (listSites(db).some((site) => site.timezone === timezone)) return false;
  for (const key of settingKeysWithPrefix(db, zoneSaltPrefix(timezone))) deleteSetting(db, key);
  return true;
}

/** `salt:<IANA zone>:` — every day salt of one zone, and nothing else's. */
function zoneSaltPrefix(timezone: string): string {
  return `${DAY_SALT_PREFIX}${timezone}:`;
}

/** `salt:<IANA zone>:<YYYY-MM-DD>` — one salt per zone per site-local day (docs/03). */
function daySaltKey(timezone: string, date: string): string {
  return zoneSaltPrefix(timezone) + date;
}

/**
 * A day-salt key from before the boundary moved: `salt:<date>`, no zone segment
 * (no stored zone contains a colon — `isValidTimezone` refuses one). Nothing
 * reads one now, so the next rotation destroys it — a salt nothing reads must
 * not outlive the day it keyed.
 */
function isZonelessSaltKey(key: string): boolean {
  return !key.slice(DAY_SALT_PREFIX.length).includes(':');
}

/** The zone's live salt and the local date it belongs to. */
interface DaySalt {
  date: string;
  salt: Buffer;
}

/**
 * Cookieless visitor identity (docs/03):
 * `visitor_id = first 8 bytes of SHA-256(day_salt ∥ site_id ∥ ip ∥ user_agent)`.
 *
 * The day salt rotates at **site-local** midnight, the boundary `local_date`
 * already uses, so a visitor id belongs to exactly one of the days the
 * dashboards bucket on. It is keyed by TIMEZONE rather than by site: `site_id`
 * is inside the hash, so sites sharing a zone share a salt row without their
 * ids colliding, and a single-zone install keeps one salt per day.
 *
 * Rotation is forward only, so a backward clock step (NTP, or a zone that moves
 * its clock back across midnight) can never re-mint the current salt and re-key
 * every visitor mid-day — and every strictly older salt *in that zone* is
 * deleted, making yesterday's hashes unlinkable to today's. A Matomo `_id`
 * replaces the ip∥ua fingerprint input; a site-provided `uid` is hashed with a
 * stable per-site salt instead (logged-in continuity across days), but only for
 * sites that opted in — anything can append `uid` to a beacon, and honoring it
 * by default would defeat the daily rotation.
 *
 * Salt persistence writes happen inline (like `migrate` at boot): better-sqlite3
 * is synchronous, so they can never interleave with a batch flush.
 */
export class Identity {
  private readonly daySalts = new Map<string, DaySalt>();
  private readonly uidSalts = new Map<number, Buffer>();
  /** Opt-ins are read once per site and cached for the process, like the salts. */
  private readonly uidEnabled = new Map<number, boolean>();

  constructor(private readonly db: Db) {}

  /** `date` is the site-local date of `ctx.receivedAt`; the pipeline passes the one it already has. */
  visitorId(
    hit: Hit,
    ctx: HitContext,
    timezone: string,
    date: string = localClock(timezone, ctx.receivedAt).date,
  ): Uint8Array {
    if (hit.uid !== undefined && this.isUidEnabled(hit.siteId)) {
      return hash8(this.uidSalt(hit.siteId), hit.uid);
    }
    const salt = this.currentDaySalt(timezone, date);
    const fingerprint = hit.visitorId ?? `${ctx.ip}\n${ctx.userAgent}`;
    return hash8(salt, `${hit.siteId}\n${fingerprint}`);
  }

  private currentDaySalt(timezone: string, date: string): Buffer {
    const current = this.daySalts.get(timezone);
    // Forward-only, on the ISO dates' own lexicographic order: a hit timed before
    // the last rotation keeps the current salt — its own day's salt is already
    // gone, and the day stays consistent. That covers the zones whose local
    // midnight a DST shift repeats as well as it covers a clock step.
    if (current !== undefined && date <= current.date) return current.salt;
    const salt = this.rotate(timezone, date);
    this.daySalts.set(timezone, { date, salt });
    return salt;
  }

  /** Loads or creates the zone's salt for `date`; older salts are deleted (docs/03). */
  private rotate(timezone: string, date: string): Buffer {
    const key = daySaltKey(timezone, date);
    const existing = getSetting(this.db, key);
    if (existing !== undefined) return Buffer.from(existing, 'hex');
    const salt = randomBytes(16);
    const stale = supersededSalts(this.db, timezone, key);
    withWriteTransaction(this.db, () => {
      for (const old of stale) deleteSetting(this.db, old);
      setSetting(this.db, key, salt.toString('hex'));
    });
    return salt;
  }

  /** `forgetSiteIdentity`, plus the caches — an evicted zone re-reads its salts,
   * so a site created in it later mints and persists a fresh one. */
  forgetSite(siteId: number, timezone: string): boolean {
    this.uidSalts.delete(siteId);
    this.uidEnabled.delete(siteId);
    const abandoned = forgetSiteIdentity(this.db, siteId, timezone);
    if (abandoned) this.daySalts.delete(timezone);
    return abandoned;
  }

  private isUidEnabled(siteId: number): boolean {
    let enabled = this.uidEnabled.get(siteId);
    if (enabled === undefined) {
      enabled = getSetting(this.db, uidEnabledKey(siteId)) === '1';
      this.uidEnabled.set(siteId, enabled);
    }
    return enabled;
  }

  private uidSalt(siteId: number): Buffer {
    let salt = this.uidSalts.get(siteId);
    if (salt === undefined) {
      const key = uidSaltKey(siteId);
      const existing = getSetting(this.db, key);
      if (existing !== undefined) {
        salt = Buffer.from(existing, 'hex');
      } else {
        const fresh = randomBytes(16);
        withWriteTransaction(this.db, () => setSetting(this.db, key, fresh.toString('hex')));
        salt = fresh;
      }
      this.uidSalts.set(siteId, salt);
    }
    return salt;
  }
}

/**
 * Every salt `key` supersedes. Within a zone, ISO dates sort lexicographically,
 * so `< key` spares that zone's newer salt (still current for a restart whose
 * clock regressed across midnight); every other zone's salt is left alone.
 */
function supersededSalts(db: Db, timezone: string, key: string): string[] {
  const zone = zoneSaltPrefix(timezone);
  return settingKeysWithPrefix(db, DAY_SALT_PREFIX).filter((old) =>
    old.startsWith(zone) ? old < key : isZonelessSaltKey(old),
  );
}

/**
 * A site moving zones would re-key every visitor it has already seen today: its
 * next hit hashes under the new zone's salt. When the new zone has not minted a
 * salt for its current date, seed it with the old zone's live one, so those
 * visitors keep their ids until the new zone's next local midnight (docs/03
 * § Timezones). A salt the new zone already has is never replaced — another
 * site's visitors hold ids under it. Runs inside the PATCH's write transaction.
 */
export function carryDaySalt(db: Db, from: string, to: string, now: number): void {
  const live = getSetting(db, daySaltKey(from, localClock(from, now).date));
  if (live === undefined) return;
  const key = daySaltKey(to, localClock(to, now).date);
  if (getSetting(db, key) !== undefined) return;
  for (const old of supersededSalts(db, to, key)) deleteSetting(db, old);
  setSetting(db, key, live);
}

function hash8(salt: Uint8Array, input: string): Uint8Array {
  return createHash('sha256').update(salt).update(input).digest().subarray(0, 8);
}
