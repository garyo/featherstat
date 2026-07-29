/**
 * Alias color index -> CSS token. Cycling the chart palette is deliberate here:
 * identity is carried by the visitor NAME; the dot is a scanning aid
 * (packages/shared/src/alias.ts).
 */
const ALIAS_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'];

export function dotColor(color: number): string {
  return ALIAS_COLORS[color % ALIAS_COLORS.length] ?? 'var(--s1)';
}
