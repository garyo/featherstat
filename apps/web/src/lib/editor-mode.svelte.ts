import type { Dashboard } from '@featherstat/shared';
import type { DashboardStore } from './dashboards.svelte.ts';
import type { SiteScope } from './state.ts';

/**
 * The ONE import site of the code-split editor chunk (docs/05 § What
 * editability costs — the view path ships zero editor code). Everything that
 * needs a piece of it, including the view grids' lazy "show query" modal,
 * loads through here.
 */
export function loadEditor(): Promise<typeof import('../editor/editor.ts')> {
  return import('../editor/editor.ts');
}

/**
 * The edit-mode switch both dashboard views share: entering edit mode loads the
 * editor chunk, and Save routes through the store with the VIEW's scope,
 * whatever an imported document claimed.
 */
export interface EditorMode {
  /** The chunk's Editor component once edit mode is on; undefined renders the view. */
  readonly Editor: typeof import('../editor/editor.ts').Editor | undefined;
  open(): Promise<void>;
  close(): void;
  save(next: Dashboard): Promise<void>;
}

export function createEditorMode(store: DashboardStore, scope: () => SiteScope): EditorMode {
  let editing = $state(false);
  let chunk = $state<typeof import('../editor/editor.ts') | undefined>(undefined);

  return {
    get Editor() {
      return editing ? chunk?.Editor : undefined;
    },
    async open() {
      chunk = await loadEditor();
      editing = true;
    },
    close() {
      editing = false;
    },
    async save(next) {
      if (await store.save({ ...next, site: scope() })) editing = false;
    },
  };
}
