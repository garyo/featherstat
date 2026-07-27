/**
 * Country display helpers. The query vocabulary returns ISO 3166-1 alpha-2
 * codes; the flag is pure arithmetic on them (regional indicator symbols), and
 * the English name comes from Intl — no shipped country table.
 */

const REGIONAL_INDICATOR_A = 0x1f1e6;

/** `US` → 🇺🇸; anything that is not two ASCII letters → undefined. */
export function flagEmoji(code: string): string | undefined {
  if (!/^[A-Za-z]{2}$/.test(code)) return undefined;
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    REGIONAL_INDICATOR_A + upper.charCodeAt(0) - 65,
    REGIONAL_INDICATOR_A + upper.charCodeAt(1) - 65,
  );
}

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return undefined;
  }
})();

/** `US` → `United States`; falls back to the code when Intl draws a blank. */
export function countryName(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    return displayNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
