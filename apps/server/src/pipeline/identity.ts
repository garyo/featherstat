import { createHash, randomBytes } from 'node:crypto';
import { DAY_MS, type Hit, type HitContext } from '@analytics/shared';
import {
  type Db,
  deleteSetting,
  getSetting,
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

/**
 * Cookieless visitor identity (docs/03):
 * `visitor_id = first 8 bytes of SHA-256(day_salt ∥ site_id ∥ ip ∥ user_agent)`.
 *
 * The day salt rotates at 00:00 UTC — forward only, so a backward clock step
 * (NTP) can never re-mint the current salt and re-key every visitor mid-day —
 * and strictly older days' salts are deleted, making yesterday's hashes
 * unlinkable to today's. A Matomo `_id` replaces the ip∥ua fingerprint input;
 * a site-provided `uid` is hashed with a stable per-site salt instead
 * (logged-in continuity across days), but only for sites that opted in —
 * anything can append `uid` to a beacon, and honoring it by default would
 * defeat the daily rotation.
 *
 * Salt persistence writes happen inline (like `migrate` at boot): better-sqlite3
 * is synchronous, so they can never interleave with a batch flush.
 */
export class Identity {
  private day = -1;
  private daySalt: Buffer = Buffer.alloc(0);
  private readonly uidSalts = new Map<number, Buffer>();
  /** Opt-ins are read once per site and cached for the process, like the salts. */
  private readonly uidEnabled = new Map<number, boolean>();

  constructor(private readonly db: Db) {}

  visitorId(hit: Hit, ctx: HitContext): Uint8Array {
    if (hit.uid !== undefined && this.isUidEnabled(hit.siteId)) {
      return hash8(this.uidSalt(hit.siteId), hit.uid);
    }
    const salt = this.currentDaySalt(ctx.receivedAt);
    const fingerprint = hit.visitorId ?? `${ctx.ip}\n${ctx.userAgent}`;
    return hash8(salt, `${hit.siteId}\n${fingerprint}`);
  }

  private currentDaySalt(now: number): Buffer {
    const day = Math.floor(now / DAY_MS);
    // Forward-only: a hit timed before the last rotation keeps the current
    // salt — its own day's salt is already gone, and the day stays consistent.
    if (day > this.day) {
      this.daySalt = this.rotate(new Date(now).toISOString().slice(0, 10));
      this.day = day;
    }
    return this.daySalt;
  }

  /** Loads or creates the day's salt; every strictly older salt is deleted (docs/03). */
  private rotate(today: string): Buffer {
    const key = DAY_SALT_PREFIX + today;
    const existing = getSetting(this.db, key);
    if (existing !== undefined) return Buffer.from(existing, 'hex');
    const salt = randomBytes(16);
    // ISO dates sort lexicographically, so `< key` spares any newer day's salt
    // (still current for a restart whose clock regressed across midnight).
    const stale = settingKeysWithPrefix(this.db, DAY_SALT_PREFIX).filter((old) => old < key);
    withWriteTransaction(this.db, () => {
      for (const old of stale) deleteSetting(this.db, old);
      setSetting(this.db, key, salt.toString('hex'));
    });
    return salt;
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
      const key = UID_SALT_PREFIX + siteId;
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

function hash8(salt: Uint8Array, input: string): Uint8Array {
  return createHash('sha256').update(salt).update(input).digest().subarray(0, 8);
}
