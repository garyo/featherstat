import { MAX_AXIS_KEYS, type QueryResponse, type QueryResult } from '@featherstat/shared';

/**
 * How big an answer is allowed to get.
 *
 * @guard response-size
 *
 * A ratchet in the same family as the replay perf budget and the first-load
 * bundle budget (CLAUDE.md invariant 6: these tighten, never loosen).
 *
 * Nothing bounded a `/api/query` response before this. P1 caps ONE result's axis
 * at `MAX_AXIS_KEYS`, and `MetricQuerySchema` caps one query's `limit` at 1000 —
 * but a batch carries up to `MAX_QUERIES_PER_BATCH` of them, `site: 'all'` fans
 * each across every site, and the all-sites cards deliberately run an UNLIMITED
 * `path × day` query per site (`sitePagesQueries`: a LIMIT there would truncate
 * whole days rather than whole pages). That product is a stored, client-authored
 * query plan, executed server-side, reachable through a public share link — so
 * its output deserves a number, and the number deserves a test.
 *
 * Measured on the real thing: the bytes `c.json()` will serialize, for the
 * dashboards the app actually ships, at every preset a reader can pick. The
 * budgets bound THIS corpus, exactly as the bench's bytes-per-event and the
 * bundle ratchet bound their own fixed inputs; what they catch is a change that
 * makes an answer cost multiples of what it costs today.
 *
 * Today's worst case is the all-sites batch at 90 d over the 21-day contract
 * corpus: 93 122 B across 1 138 rows and 540 axis keys, and its largest single
 * result is one site's page trend at 22 805 B. The budgets sit ~1.4× above each,
 * which is room for ordinary work and not room for a dense fill.
 */

/** One `/api/query` body, whole. */
export const BATCH_MAX_BYTES = 131_072;
/** One result inside it — so a runaway breakdown is named, not averaged away. */
export const RESULT_MAX_BYTES = 32_768;
/**
 * Axis keys summed across a batch. `MAX_AXIS_KEYS` bounds one result for one
 * site; this bounds their product, which is what actually rides the wire.
 */
export const BATCH_MAX_AXIS_KEYS = 1_024;

export const isRows = (entry: QueryResult | { error: unknown }): entry is QueryResult =>
  !('error' in entry);

export const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function axisKeysOf(response: QueryResponse): number {
  return Object.values(response.results).reduce((total, entry) => {
    if (!isRows(entry) || entry.axis === undefined) return total;
    return total + entry.axis.reduce((sum, axis) => sum + axis.keys.length, 0);
  }, 0);
}

/** Per-result sizes, biggest first — the failure says WHICH result grew. */
function largestResults(response: QueryResponse): string {
  return Object.entries(response.results)
    .map(([id, entry]) => [id, bytesOf(entry)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, size]) => `${id} ${size}`)
    .join(', ');
}

/**
 * Everything the size budget would fail on for one answer: the whole body, each
 * result on its own, the axis keys it enumerated, and the two structural rules
 * the numbers rest on — rows stay sparse, and an axis is withheld rather than
 * enumerated past its own cap.
 */
export function responseSizeBreaches(name: string, response: QueryResponse): string[] {
  const breaches: string[] = [];
  const total = bytesOf(response);
  if (total >= BATCH_MAX_BYTES) {
    breaches.push(
      `${name}: ${total} >= ${BATCH_MAX_BYTES} B (largest: ${largestResults(response)})`,
    );
  }
  for (const [id, entry] of Object.entries(response.results)) {
    const size = bytesOf(entry);
    if (size >= RESULT_MAX_BYTES)
      breaches.push(`${name} '${id}': ${size} >= ${RESULT_MAX_BYTES} B`);
  }
  const keys = axisKeysOf(response);
  if (keys >= BATCH_MAX_AXIS_KEYS) {
    breaches.push(`${name}: ${keys} >= ${BATCH_MAX_AXIS_KEYS} axis keys`);
  }
  for (const [id, entry] of Object.entries(response.results)) {
    if (!isRows(entry) || entry.axis === undefined) continue;
    const enumerated = entry.axis.reduce((sum, axis) => sum + axis.keys.length, 0);
    // Dense zero-filling was the original sketch and would make a 2-D result the
    // product of its two dimensions — tens of thousands of manufactured rows,
    // down a code path a client-authored layout reaches through a share link.
    if (entry.rows.length > enumerated) {
      breaches.push(`${name} '${id}': ${entry.rows.length} rows for ${enumerated} axis keys`);
    }
    for (const axis of entry.axis) {
      if (axis.keys.length > MAX_AXIS_KEYS) {
        breaches.push(
          `${name} '${id}' site ${axis.siteId}: ${axis.keys.length} > ${MAX_AXIS_KEYS} axis keys`,
        );
      }
    }
  }
  return breaches;
}
