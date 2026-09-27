import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Text contrast of the theme tokens (WCAG 2.x AA: 4.5:1 for text under 18px).
 * `--muted` and `--ink-2` set 11–13px text on the page and on cards, and the
 * row asides (`--ink-2`) sit on the `--wash` bar too — so each pair below is a
 * combination the dashboard actually draws.
 */

const CSS = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** The light tokens, then the dark ones (the explicit `data-theme` block). */
function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  const block = CSS.slice(start, CSS.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [
      match[1] as string,
      match[2] as string,
    ]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS = [
  ['muted', 'page'],
  ['muted', 'surface'],
  ['ink-2', 'page'],
  ['ink-2', 'surface'],
  ['ink-2', 'wash'],
] as const;

describe.each([
  ['light', tokens(':root {')],
  ['dark', tokens(':root[data-theme="dark"] {')],
])('%s theme text contrast', (_name, theme) => {
  it.each(PAIRS)('--%s on --%s is at least 4.5:1', (text, ground) => {
    expect(theme[text]).toBeDefined();
    expect(contrast(theme[text] as string, theme[ground] as string)).toBeGreaterThanOrEqual(4.5);
  });
});
