/**
 * Where a key moves a position along a list of `count` things — the one
 * keyboard grammar for stepping a chart's crosshair and moving a widget in the
 * editor: the arrows step one (left/up back, right/down on), Home and End jump
 * to the ends. Undefined for any other key, or when the move goes nowhere, so a
 * caller only claims (preventDefault) the keys it acts on.
 */
export function keyStep(key: string, at: number, count: number): number | undefined {
  const last = count - 1;
  const target =
    key === 'ArrowLeft' || key === 'ArrowUp'
      ? at - 1
      : key === 'ArrowRight' || key === 'ArrowDown'
        ? at + 1
        : key === 'Home'
          ? 0
          : key === 'End'
            ? last
            : undefined;
  if (target === undefined || count === 0) return undefined;
  return Math.max(0, Math.min(last, target));
}
