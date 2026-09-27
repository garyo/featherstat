import type { Dashboard } from '@featherstat/shared';
import { loadChunk } from './chunks.ts';
import type { DashboardStore } from './dashboards.svelte.ts';
import type { SiteScope } from './state.ts';

/**
 * The ONE import site of the code-split editor chunk (docs/05 § What
 * editability costs — the view path ships zero editor code). Everything that
 * needs a piece of it, including the view grids' lazy "show query" modal,
 * loads through here. Undefined means the chunk is unreachable — the shell says
 * why, so a caller just renders nothing.
 */
export function loadEditor(): Promise<typeof import('../editor/editor.ts') | undefined> {
  return loadChunk(() => import('../editor/editor.ts'));
}

/**
 * The edit-mode switch both dashboard views share: entering edit mode loads the
 * editor chunk, and Save routes through the store with the VIEW's scope,
 * whatever an imported document claimed.
 */
export interface EditorMode {
  /** The chunk's Editor component once edit mode is on; undefined renders the view. */
  readonly Editor: typeof import('../editor/editor.ts').Editor | undefined;
  /** True while a draft is open — a switch away must go through `confirmDashboardSwitch`. */
  readonly editing: boolean;
  /** True while the open draft differs from the dashboard it was opened on. */
  readonly dirty: boolean;
  open(): Promise<void>;
  /** Leaves edit mode, discarding the draft. */
  close(): void;
  /** The editor reports its draft's state here, so a switch away knows whether to ask. */
  setDirty(dirty: boolean): void;
  /** True when the store accepted the save — editing a template just cloned it,
   * and the caller may want to point the URL at the new row. */
  save(next: Dashboard): Promise<boolean>;
}

/**
 * Whether a switch away from a dashboard being edited may proceed — every
 * navigation that would discard a draft asks first, and only when the draft
 * holds a change to lose. Pure so the decision is testable; the caller supplies
 * `window.confirm` and, on a yes, closes the mode (discarding the draft) BEFORE
 * switching.
 */
export function confirmDashboardSwitch(
  dirty: boolean,
  name: string | undefined,
  ask: (message: string) => boolean,
): boolean {
  return !dirty || ask(`Discard unsaved changes to ${name ?? 'this dashboard'}?`);
}

export function createEditorMode(store: DashboardStore, scope: () => SiteScope): EditorMode {
  let editing = $state(false);
  let dirty = $state(false);
  let chunk = $state<typeof import('../editor/editor.ts') | undefined>(undefined);

  return {
    get Editor() {
      return editing ? chunk?.Editor : undefined;
    },
    get editing() {
      return editing;
    },
    get dirty() {
      return editing && dirty;
    },
    async open() {
      chunk = await loadEditor();
      // Without the chunk there is no editor to enter; the stale-build notice
      // is already up, and flipping this would blank the dashboard behind it.
      if (chunk !== undefined) editing = true;
    },
    close() {
      editing = false;
      dirty = false;
    },
    setDirty(next) {
      dirty = next;
    },
    async save(next) {
      const saved = await store.save({ ...next, site: scope() });
      if (saved) {
        editing = false;
        dirty = false;
      }
      return saved;
    },
  };
}
