/**
 * The dimensions that have an entity detail view (docs/05 § Detail views).
 * Deliberately its own tiny module: the drill affordance in the first-load
 * bar rows needs only this list — the template builders live in siblings the
 * code-split detail view imports, so they never ride the entry chunk.
 */
export const DETAIL_DIMENSIONS = ['path', 'ref_domain', 'utm_campaign'] as const;
export type DetailDimension = (typeof DETAIL_DIMENSIONS)[number];

export function isDetailDimension(dim: string): dim is DetailDimension {
  return (DETAIL_DIMENSIONS as readonly string[]).includes(dim);
}
