import type { Migration } from '../migrate.ts';
import { migration001 } from './001-init.ts';

/** Applied in order at boot. Append only — never edit or renumber a shipped migration. */
export const MIGRATIONS: readonly Migration[] = [migration001];
