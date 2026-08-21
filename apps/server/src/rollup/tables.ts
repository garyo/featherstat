import type { BaseDimension } from '@featherstat/shared';
import type { EventRow, SessionRow } from '../db/index.ts';

/**
 * The closed dimension → rollup mapping (docs/03 § Rollups). Exhaustive over
 * `DimensionSchema` on purpose — adding a dimension without deciding whether it
 * rolls up is a type error, mirroring how `compiler.ts` keeps `DIMS` closed.
 *
 * A rolled dimension gets a small integer `dimId`. **These ids are frozen
 * forever**: they key rows in `rollup_dim_day` / `rollup_sessions_day` and the
 * presence tables, which outlive raw events (that is their point), so reusing
 * or renumbering one would silently merge two dimensions' history. New rolled
 * dimensions append the next id; retired ones leave a hole.
 *
 * `tables` says which side maintains rows for the dimension: `events` feeds
 * `rollup_dim_day` (+ the presence tables), `sessions` feeds
 * `rollup_sessions_day` over the session's first-touch value, `both` feeds
 * both. The split follows the compiler's `DIMS`: a dimension rolls on a side
 * exactly when that table carries the column.
 */
export type RollupDimEntry =
  | { dimId: number; tables: 'events' | 'sessions' | 'both' }
  /** Answerable from a rollup row's own key columns — no dimension rows needed. */
  | 'derived'
  /** Queries by it go to raw events forever (high cardinality, low value). */
  | 'raw-only';

export const ROLLUP_DIMS: Record<BaseDimension, RollupDimEntry> = {
  path: { dimId: 1, tables: 'events' },
  hostname: { dimId: 2, tables: 'events' },
  ref_domain: { dimId: 3, tables: 'both' },
  ref_type: { dimId: 4, tables: 'both' },
  utm_source: { dimId: 5, tables: 'both' },
  utm_medium: { dimId: 6, tables: 'both' },
  utm_campaign: { dimId: 7, tables: 'both' },
  country: { dimId: 8, tables: 'both' },
  region: { dimId: 9, tables: 'both' },
  city: { dimId: 10, tables: 'both' },
  browser: { dimId: 11, tables: 'both' },
  os: { dimId: 12, tables: 'both' },
  device_type: { dimId: 13, tables: 'both' },
  screen: { dimId: 14, tables: 'events' },
  lang: { dimId: 15, tables: 'events' },
  event_category: { dimId: 16, tables: 'events' },
  event_action: { dimId: 17, tables: 'events' },
  event_name: { dimId: 18, tables: 'events' },
  target_url: { dimId: 19, tables: 'events' },
  entry_path: { dimId: 20, tables: 'sessions' },
  exit_path: { dimId: 21, tables: 'sessions' },
  title: 'raw-only',
  // Derived from the campaigns REGISTRY at query time, not from rollup keys:
  // a registry edit re-labels history instantly, which no stored row could.
  campaign_status: 'raw-only',
  site: 'derived', // every rollup row is keyed by site_id
  local_hour: 'derived', // rollup_traffic_hour's own grain
  weekday: 'derived', // a function of local_date
};

/** The undimensioned row every rollup key set includes — totals without a dimension. */
export const NO_DIM_ID = 0;

/**
 * How many trailing local dates keep presence rows. The daily salt closes each
 * day, so ingest can only ever touch the last couple of local dates (clock skew
 * across zones included); presence rows for older days serve nothing and the
 * write path prunes them at day rollover. A rebuild repopulates them only
 * inside this horizon — older days' distincts come straight from raw
 * `COUNT(DISTINCT …)`, same numbers, no rows.
 */
export const PRESENCE_HORIZON_DAYS = 3;

/** One rolled dimension and the column it reads — column names ARE dimension names. */
export interface RolledDim<Column> {
  dim: BaseDimension;
  dimId: number;
  column: Column;
}

/** Nullable string columns a rolled dimension may read on each side.
 * (`local_hour` is excluded on both: it shares a name with a dimension but is
 * numeric, and it is 'derived' — a rollup key column, never a rolled value.
 * Sessions carry one too, the hour the visit started.) */
export type EventDimColumn = Exclude<Extract<keyof EventRow, BaseDimension>, 'local_hour'>;
export type SessionDimColumn = Exclude<Extract<keyof SessionRow, BaseDimension>, 'local_hour'>;

function rolled<Column extends string>(sides: readonly ('events' | 'sessions' | 'both')[]) {
  const dims: RolledDim<Column>[] = [];
  for (const [dim, entry] of Object.entries(ROLLUP_DIMS) as [BaseDimension, RollupDimEntry][]) {
    if (typeof entry === 'string' || !sides.includes(entry.tables)) continue;
    // Row types name columns exactly as `DimensionSchema` names dimensions
    // (docs/03: column names verbatim); tables.test.ts holds this in step with
    // the compiler's DIMS, which is what makes the cast safe.
    dims.push({ dim, dimId: entry.dimId, column: dim as unknown as Column });
  }
  return dims;
}

/** Rolled dimensions maintained from event rows → `rollup_dim_day` + presence tables. */
export const EVENT_ROLLUP_DIMS: readonly RolledDim<EventDimColumn>[] = rolled(['events', 'both']);

/** Rolled dimensions maintained from session rows → `rollup_sessions_day`. */
export const SESSION_ROLLUP_DIMS: readonly RolledDim<SessionDimColumn>[] = rolled([
  'sessions',
  'both',
]);
