import { describe, expect, it } from 'vitest';
import {
  dataSettingsBody,
  dataSettingsDraft,
  dropTotals,
  formatBytes,
  localInputToMs,
  msToLocalInput,
  parseDomains,
  trackingSnippet,
} from './settings.ts';

describe('trackingSnippet', () => {
  it('targets this deployment and the chosen site', () => {
    const snippet = trackingSnippet(7, 'https://analytics.example.com');
    expect(snippet).toContain("import { init } from 'https://analytics.example.com/tracker.js'");
    expect(snippet).toContain(
      "init({ site: 7, endpoint: 'https://analytics.example.com/api/collect' })",
    );
    expect(snippet.startsWith('<script type="module">')).toBe(true);
    expect(snippet.endsWith('</script>')).toBe(true);
  });

  // The shim owns `_paq`, so it cannot run beside a real Matomo tag during a
  // comparison; offering it here would steer new sites into the one path that
  // cannot dual-run (docs/06 § Already running Matomo?).
  it('is the native tag, never the matomo.js shim', () => {
    const snippet = trackingSnippet(7, 'https://analytics.example.com');
    expect(snippet).not.toContain('_paq');
    expect(snippet).not.toContain('matomo');
  });

  it('never doubles the slash when the origin already ends with one', () => {
    expect(trackingSnippet(1, 'https://a.test/')).toContain("from 'https://a.test/tracker.js'");
    expect(trackingSnippet(1, 'https://a.test/')).not.toContain('a.test//');
  });
});

describe('formatBytes', () => {
  it('picks the readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(3.4 * 1024 ** 4)).toBe('3.4 TB');
  });
});

describe('parseDomains', () => {
  it('splits, trims and drops empties', () => {
    expect(parseDomains(' a.com , b.com ,, ')).toEqual(['a.com', 'b.com']);
    expect(parseDomains('')).toEqual([]);
    expect(parseDomains('one.test')).toEqual(['one.test']);
  });
});

describe('dropTotals', () => {
  it('sums per site, largest first', () => {
    expect(
      dropTotals([
        { siteId: 1, localDate: '2026-07-27', count: 2 },
        { siteId: 2, localDate: '2026-07-27', count: 9 },
        { siteId: 1, localDate: '2026-07-26', count: 3 },
      ]),
    ).toEqual([
      [2, 9],
      [1, 5],
    ]);
  });

  it('is empty for no drops', () => {
    expect(dropTotals([])).toEqual([]);
  });
});

describe('datetime-local round trip', () => {
  it('survives the trip through the input format', () => {
    const ms = Date.UTC(2026, 6, 4, 12, 30);
    const input = msToLocalInput(ms);
    expect(input).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(localInputToMs(input)).toBe(ms);
  });

  it('answers undefined for blank or partial input', () => {
    expect(localInputToMs('')).toBeUndefined();
    expect(localInputToMs('2026-07-')).toBeUndefined();
  });
});

describe('dataSettingsBody', () => {
  it('round-trips what the server stored', () => {
    const stored = { retentionDays: 90, backupDir: '/data/backups', backupKeep: 7 };
    expect(dataSettingsBody(dataSettingsDraft(stored))).toEqual({ body: stored });
  });

  it('sends a blank directory as backups-off and a cleared retention as forever', () => {
    expect(dataSettingsBody({ retention: null, backupDir: '  ', backupKeep: 3 })).toEqual({
      body: { retentionDays: null, backupDir: null, backupKeep: 3 },
    });
  });

  it('refuses an empty backup count rather than inventing one', () => {
    expect(dataSettingsBody({ retention: 30, backupDir: '', backupKeep: null })).toEqual({
      error: 'say how many backups to keep',
    });
  });
});
