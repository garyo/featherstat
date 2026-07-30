import type { Migration } from '../migrate.ts';
import { migration001 } from './001-init.ts';
import { migration002 } from './002-admin-sessions.ts';
import { migration003 } from './003-dashboards.ts';
import { migration004 } from './004-visitor-covering-index.ts';

/** Applied in order at boot. Append only — never edit or renumber a shipped migration. */
export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
];
