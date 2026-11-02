import type { SiteRef } from '@featherstat/shared';
import {
  connectionDataVersion,
  type Db,
  getSite,
  listSites,
  type Site,
  siteGeneration,
} from '../db/index.ts';

/**
 * The ingest pipeline's copy of `sites`, so a hit costs no table read, JSON
 * parse or zod pass for the site it names.
 *
 * Stale the moment anything could have changed a site: a write through the db
 * helpers on this connection bumps `siteGeneration`, and a commit from any
 * other connection — the Matomo importer creating sites while the server runs
 * — moves `connectionDataVersion`. Both are checked on every lookup; either one clears
 * the lot, since site edits are rare and the table is small.
 *
 * Only known sites are held. An unknown id costs its lookup every time, which
 * is what keeps a flood of made-up `idsite` values from growing this without
 * bound. Domains are the exception: a domain lookup needs every site's list,
 * so the first one after a change reads the whole (small) table and an unknown
 * domain then costs a map miss.
 */
export class SiteCache {
  private readonly sites = new Map<number, Site>();
  /** Lowercased domain → site id; built on the first domain lookup after a change. */
  private domains: Map<string, number> | undefined;
  private generation = -1;
  private version = -1;

  constructor(private readonly db: Db) {}

  get(id: number): Site | undefined {
    this.revalidate();
    const held = this.sites.get(id);
    if (held !== undefined) return held;
    const site = getSite(this.db, id);
    // Inside a transaction the row may be an edit that never commits; keeping
    // it would outlive the rollback, which bumps nothing.
    if (site !== undefined && !this.db.inTransaction) this.sites.set(id, site);
    return site;
  }

  /** A tracker's site reference → the site it names (docs/04 § 2), or undefined. */
  resolve(ref: SiteRef): Site | undefined {
    if (typeof ref === 'number') return this.get(ref);
    this.revalidate();
    const id = this.domainMap().get(ref.toLowerCase());
    return id === undefined ? undefined : this.get(id);
  }

  private domainMap(): Map<string, number> {
    if (this.domains !== undefined) return this.domains;
    const domains = new Map<string, number>();
    // Listed by id, so were two sites ever to share a domain (the routes refuse
    // it; an import could predate the rule) the older site keeps it.
    for (const site of listSites(this.db)) {
      for (const domain of site.domains) {
        const key = domain.toLowerCase();
        if (!domains.has(key)) domains.set(key, site.id);
      }
    }
    if (!this.db.inTransaction) this.domains = domains;
    return domains;
  }

  private revalidate(): void {
    const generation = siteGeneration(this.db);
    const version = connectionDataVersion(this.db);
    if (generation === this.generation && version === this.version) return;
    this.sites.clear();
    this.domains = undefined;
    this.generation = generation;
    this.version = version;
  }
}
