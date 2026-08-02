import type { Dashboard } from '@featherstat/shared';
import type { AdminClient } from './admin.ts';
import { type LibraryEntry, libraryFor, resolveDashRef } from './dashboards.ts';
import type { DashRef, SiteScope } from './state.ts';

/**
 * One scope's dashboard library, loaded from the admin API (docs/05 § The
 * dashboard library): the shipped templates plus the stored rows, one of which
 * the URL's `dash` ref selects. A stored selection loads its layout; a template
 * selection renders from code (the views build it). The first save of a
 * template selection CLONES it — creates a row recording the template id — and
 * every later save updates that row. Views hold their query batch until
 * `ready`, so the one-fetch rule survives persistence — never a
 * default-then-stored double batch on load.
 */
export interface DashboardStore {
  /** The scope's library in display order; empty until the list answers. */
  readonly library: LibraryEntry[];
  /** What the loaded (scope, dash) resolved to; undefined until ready (or when the list failed). */
  readonly selection: LibraryEntry | undefined;
  /** The stored layout when the selection is a stored row; undefined for templates. */
  readonly stored: Dashboard | undefined;
  /** Row id of the selected stored dashboard — the save/share target; undefined for templates. */
  readonly id: number | undefined;
  /** True once the current (scope, dash) lookup answered, either way. */
  readonly ready: boolean;
  readonly saving: boolean;
  /** The last failed save's message, cleared by the next attempt. */
  readonly error: string | undefined;
  /** (Re)loads a scope's library + selection; a newer call wins over an in-flight older one. */
  load(scope: SiteScope, dash: DashRef | undefined): void;
  /** Re-runs the current lookup — after a management action changed the library. */
  refresh(): Promise<void>;
  /** Update the selected row, or clone the selected template; false (and `error`) on failure. */
  save(layout: Dashboard): Promise<boolean>;
}

export function createDashboardStore(admin: AdminClient): DashboardStore {
  let library = $state<LibraryEntry[]>([]);
  let selection = $state<LibraryEntry | undefined>(undefined);
  let stored = $state<Dashboard | undefined>(undefined);
  let ready = $state(false);
  let saving = $state(false);
  let error = $state<string | undefined>(undefined);
  /** Row id backing `stored` — the PUT target once a row exists, and the share target. */
  let id = $state<number | undefined>(undefined);
  let seq = 0;
  let scope: SiteScope = 'all';
  let dash: DashRef | undefined;
  /** The in-flight lookup — `save` awaits it, so a save racing the initial load
   * can never miss the row id and mint a duplicate row for the scope. */
  let loading: Promise<void> = Promise.resolve();

  function load(nextScope: SiteScope, nextDash: DashRef | undefined): void {
    scope = nextScope;
    dash = nextDash;
    const mine = ++seq;
    ready = false;
    stored = undefined;
    id = undefined;
    selection = undefined;
    loading = (async () => {
      try {
        const list = await admin.listDashboards();
        if (mine !== seq) return;
        library = libraryFor(list, scope);
        const entry = resolveDashRef(library, dash);
        selection = entry;
        if (entry?.kind === 'stored') {
          // The id lands before the detail fetch: even if the layout read fails
          // (or the row is unreadable), a later save PUTs the existing row —
          // repairing it — instead of creating a shadowed duplicate.
          id = entry.ref;
          const detail = await admin.getDashboard(entry.ref);
          if (mine !== seq) return;
          stored = detail.layout;
        }
      } catch {
        // The admin API failing must not blank the dashboard — the views fall
        // back to the shipped default (selection stays what resolved, if it did).
        if (mine !== seq) return;
      }
      ready = true;
    })();
  }

  return {
    get library() {
      return library;
    },
    get selection() {
      return selection;
    },
    get stored() {
      return stored;
    },
    get id() {
      return id;
    },
    get ready() {
      return ready;
    },
    get saving() {
      return saving;
    },
    get error() {
      return error;
    },
    load,
    refresh() {
      load(scope, dash);
      return loading;
    },
    async save(layout) {
      saving = true;
      error = undefined;
      try {
        // Never save past an unanswered lookup: creating a row the scope already
        // has selected would fork it.
        await loading;
        // A template selection clones on first save, recording its lineage so
        // the clone can be reset (docs/05 § The dashboard library).
        const template = selection?.kind === 'template' ? selection.template.id : undefined;
        const detail =
          id === undefined
            ? await admin.createDashboard(layout, template)
            : await admin.updateDashboard(id, layout);
        stored = detail.layout;
        id = detail.id;
        return true;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        return false;
      } finally {
        saving = false;
      }
    },
  };
}
