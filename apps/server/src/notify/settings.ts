import { type NtfyRule, NtfyRulesSchema, type NtfySettingsInput } from '@featherstat/shared';
import { type Db, deleteSetting, getSetting, setSetting } from '../db/index.ts';

/**
 * ntfy configuration (docs/01 R16) lives in the `settings` table like every
 * other setting — one row per field, editable through the admin API, readable
 * by the notifier without a restart.
 */

export const NTFY_SETTING_KEYS = {
  url: 'ntfy_url',
  topic: 'ntfy_topic',
  token: 'ntfy_token',
  rules: 'ntfy_rules',
} as const;

export interface NtfySettings {
  /** Absent until configured; the notifier stays idle without both url and topic. */
  url?: string;
  topic?: string;
  token?: string;
  rules: NtfyRule[];
}

export function readNtfySettings(
  db: Db,
  warn: (line: string) => void = console.warn,
): NtfySettings {
  const settings: NtfySettings = { rules: readRules(db, warn) };
  const url = getSetting(db, NTFY_SETTING_KEYS.url);
  const topic = getSetting(db, NTFY_SETTING_KEYS.topic);
  const token = getSetting(db, NTFY_SETTING_KEYS.token);
  if (url !== undefined) settings.url = url;
  if (topic !== undefined) settings.topic = topic;
  if (token !== undefined) settings.token = token;
  return settings;
}

/** Runs inside the caller's write transaction (docs/02 single writer). */
export function writeNtfySettings(db: Db, input: NtfySettingsInput): void {
  setSetting(db, NTFY_SETTING_KEYS.url, input.url);
  setSetting(db, NTFY_SETTING_KEYS.topic, input.topic);
  setSetting(db, NTFY_SETTING_KEYS.rules, JSON.stringify(input.rules));
  if (input.token === undefined) return; // omitted: keep whatever is stored
  if (input.token === null || input.token === '') deleteSetting(db, NTFY_SETTING_KEYS.token);
  else setSetting(db, NTFY_SETTING_KEYS.token, input.token);
}

/** Turns notifications off entirely: endpoint, token and rules all forgotten. */
export function clearNtfySettings(db: Db): void {
  for (const key of Object.values(NTFY_SETTING_KEYS)) deleteSetting(db, key);
}

/**
 * Site deletion companion: rules naming the site go. The live notifier keeps
 * its copy until its next reload, which is harmless — ingest drops a
 * tombstoned site's hits before any rule sees them.
 */
export function dropSiteFromNtfyRules(db: Db, siteId: number): void {
  const rules = readRules(db, () => {});
  const kept = rules.filter((rule) => rule.site !== siteId);
  if (kept.length !== rules.length) setSetting(db, NTFY_SETTING_KEYS.rules, JSON.stringify(kept));
}

/** A row we cannot validate disables notifications rather than taking ingest down. */
function readRules(db: Db, warn: (line: string) => void): NtfyRule[] {
  const raw = getSetting(db, NTFY_SETTING_KEYS.rules);
  if (raw === undefined) return [];
  try {
    const parsed = NtfyRulesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    warn(`${NTFY_SETTING_KEYS.rules} is not a valid rule list — notifications are off`);
  } catch {
    warn(`${NTFY_SETTING_KEYS.rules} is not valid JSON — notifications are off`);
  }
  return [];
}
