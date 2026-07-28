/**
 * Drag-reorder geometry (docs/05 § What editability costs: native pointer
 * events + CSS transforms, no DnD library, no reflow during drag). Card rects
 * are measured ONCE at drag start; while dragging only the grabbed card's
 * transform and the target's highlight class change; the drop commits the
 * reorder and lets the grid lay out once.
 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The index the pointer would drop on: the card under it, else the nearest by
 * center distance — so a drag released in a gutter still lands sensibly.
 */
export function dropIndex(rects: readonly Rect[], x: number, y: number, fallback: number): number {
  let best = fallback;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect === undefined) continue;
    if (
      x >= rect.left &&
      x <= rect.left + rect.width &&
      y >= rect.top &&
      y <= rect.top + rect.height
    ) {
      return i;
    }
    const dx = x - (rect.left + rect.width / 2);
    const dy = y - (rect.top + rect.height / 2);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
