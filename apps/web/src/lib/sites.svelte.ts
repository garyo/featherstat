import { type SiteInfo, SiteInfoSchema } from '@analytics/shared';

/**
 * The site directory (`GET /api/sites`): names for the header switcher, cards
 * and document titles, fetched once per app life — it changes when an admin
 * edits sites (settings calls `reload()`), not when traffic lands. Validated
 * at the boundary like every other HTTP body.
 */
export interface SiteDirectory {
  /** Undefined while loading; [] after a failure — views fall back to "Site N". */
  readonly sites: SiteInfo[] | undefined;
  readonly byId: ReadonlyMap<number, SiteInfo>;
  nameOf(id: number): string;
  /** Re-fetches after an admin edit; a failed reload keeps what is shown. */
  reload(): Promise<void>;
}

export function createSiteDirectory(fetchImpl: typeof fetch = fetch): SiteDirectory {
  let sites = $state<SiteInfo[] | undefined>(undefined);
  const byId = $derived(new Map((sites ?? []).map((site) => [site.id, site])));

  const reload = async (): Promise<void> => {
    try {
      const response = await fetchImpl('/api/sites');
      if (!response.ok) throw new Error(`sites: ${response.status}`);
      const raw = (await response.json()) as unknown[];
      sites = raw.map((site) => SiteInfoSchema.parse(site));
    } catch {
      sites ??= []; // names degrade to ids; the dashboard still works
    }
  };
  void reload();

  return {
    get sites() {
      return sites;
    },
    get byId() {
      return byId;
    },
    nameOf(id: number): string {
      return byId.get(id)?.name ?? `Site ${id}`;
    },
    reload,
  };
}
