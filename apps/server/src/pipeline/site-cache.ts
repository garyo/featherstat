import { connectionDataVersion, type Db, getSite, type Site, siteGeneration } from '../db/index.ts';

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
 * bound.
 */
export class SiteCache {
  private readonly sites = new Map<number, Site>();
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

  private revalidate(): void {
    const generation = siteGeneration(this.db);
    const version = connectionDataVersion(this.db);
    if (generation === this.generation && version === this.version) return;
    this.sites.clear();
    this.generation = generation;
    this.version = version;
  }
}
