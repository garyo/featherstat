import { type SegmentInfo, SegmentInfoSchema } from '@featherstat/shared';

/**
 * The saved segments a view may filter by (`GET /api/segments` — a read for any
 * gated principal, docs/04 § 3). Modelled on `sites.svelte.ts`: fetched once per
 * app life, validated at the boundary, and degrading to an empty list rather
 * than an error — a segment list that will not load costs the filter editor one
 * button, not the dashboard.
 */
export interface SegmentDirectory {
  /** Undefined while loading; [] after a failure. */
  readonly segments: SegmentInfo[] | undefined;
  readonly names: ReadonlyMap<number, string>;
  reload(): Promise<void>;
}

export function createSegmentDirectory(fetchImpl: typeof fetch = fetch): SegmentDirectory {
  let segments = $state<SegmentInfo[] | undefined>(undefined);
  const names = $derived(new Map((segments ?? []).map((info) => [info.id, info.name])));

  const reload = async (): Promise<void> => {
    try {
      const response = await fetchImpl('/api/segments');
      if (!response.ok) throw new Error(`segments: ${response.status}`);
      const raw = (await response.json()) as unknown[];
      segments = raw.map((info) => SegmentInfoSchema.parse(info));
    } catch {
      segments ??= [];
    }
  };
  void reload();

  return {
    get segments() {
      return segments;
    },
    get names() {
      return names;
    },
    reload,
  };
}
