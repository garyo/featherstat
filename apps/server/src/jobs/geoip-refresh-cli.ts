import { DEFAULT_MMDB_PATH, refreshGeoipDatabase } from './geoip-refresh.ts';

/**
 * Manual GeoIP install/refresh — the job the scheduler otherwise runs monthly.
 * Also the deliberate first install: nothing downloads a few hundred MB on its
 * own (docs/01 R4).
 *
 *   bun run --cwd apps/server geoip-refresh
 */

const path = process.env.GEOIP_MMDB_PATH ?? DEFAULT_MMDB_PATH;

try {
  const { url, month, bytes } = await refreshGeoipDatabase({ path });
  console.log(`installed ${path}`);
  console.log(`  edition  ${month}`);
  console.log(`  source   ${url}`);
  console.log(`  size     ${(bytes / 1_048_576).toFixed(1)} MiB`);
} catch (error) {
  console.error('geoip refresh failed:', error);
  process.exitCode = 1;
}
