import type { Migration } from '../migrate.ts';
import { migration100 } from './100-v2-init.ts';
import { migration101 } from './101-ref-domain-raw.ts';
import { migration102 } from './102-excluded-drops.ts';
import { migration103 } from './103-users.ts';
import { migration104 } from './104-session-local-hour.ts';
import { migration105 } from './105-rollup-total-index.ts';
import { migration106 } from './106-missing-hits.ts';

/**
 * Applied in order at boot. Append only — never edit or renumber a shipped
 * migration. The v2 line starts at 100 (100-v2-init.ts explains why); v1
 * databases (versions 1–99) are refused by migrate.ts with an instruction to
 * run the importer.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration100,
  migration101,
  migration102,
  migration103,
  migration104,
  migration105,
  migration106,
];
