import type { Dashboard } from '@featherstat/shared';
import type { AdminClient } from './admin.ts';
import { type DashboardInfo, storedDashboardFor } from './dashboards.ts';
import type { SiteScope } from './state.ts';

/**
 * One scope's stored dashboard, loaded from the admin API (docs/05 § Widgets):
 * present → it replaces the shipped default; absent (or unreachable) → the view
 * falls back to the default it already ships. The first save creates the row;
 * every later save updates it. Views hold their query batch until `ready`, so
 * the one-fetch rule survives persistence — never a default-then-stored double
 * batch on load.
 */
export interface DashboardStore {
  /** The stored layout for the loaded scope; undefined means "use the default". */
  readonly stored: Dashboard | undefined;
  /** Row id of the stored dashboard — what a share link points at; undefined until one exists. */
  readonly id: number | undefined;
  /** True once the current scope's lookup answered, either way. */
  readonly ready: boolean;
  readonly saving: boolean;
  /** The last failed save's message, cleared by the next attempt. */
  readonly error: string | undefined;
  /** (Re)loads a scope's dashboard; a newer call wins over an in-flight older one. */
  load(scope: SiteScope): void;
  /** Create-or-update for the loaded scope; resolves false (and sets `error`) on failure. */
  save(layout: Dashboard): Promise<boolean>;
}

export function createDashboardStore(admin: AdminClient): DashboardStore {
  let stored = $state<Dashboard | undefined>(undefined);
  let ready = $state(false);
  let saving = $state(false);
  let error = $state<string | undefined>(undefined);
  /** Row id backing `stored` — the PUT target once a row exists, and the share target. */
  let id = $state<number | undefined>(undefined);
  let seq = 0;
  /** The in-flight lookup — `save` awaits it, so a save racing the initial load
   * can never miss the row id and mint a duplicate row for the scope. */
  let loading: Promise<void> = Promise.resolve();

  return {
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
    load(scope) {
      const mine = ++seq;
      ready = false;
      stored = undefined;
      id = undefined;
      loading = (async () => {
        let info: DashboardInfo | undefined;
        try {
          info = storedDashboardFor(await admin.listDashboards(), scope);
          if (mine !== seq) return;
          // The id lands before the detail fetch: even if the layout read fails
          // (or the row is unreadable), a later save PUTs the existing row —
          // repairing it — instead of creating a shadowed duplicate.
          id = info?.id;
          const detail = info === undefined ? undefined : await admin.getDashboard(info.id);
          if (mine !== seq) return;
          stored = detail?.layout;
        } catch {
          // The admin API failing must not blank the dashboard — fall back to the default.
          if (mine !== seq) return;
        }
        ready = true;
      })();
    },
    async save(layout) {
      saving = true;
      error = undefined;
      try {
        // Never save past an unanswered lookup: creating a row the scope already
        // has would fork it, and the older row wins every later load.
        await loading;
        const detail =
          id === undefined
            ? await admin.createDashboard(layout)
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
