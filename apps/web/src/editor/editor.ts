/**
 * The code-split editor chunk's entry (docs/05 § What editability costs:
 * drag-reorder, settings panels and the query picker load on entering edit
 * mode; the view path ships zero editor code). Views reach it only via
 * `import('./editor/editor.ts')` — a static value import from view-path code
 * would fold this chunk into the entry and fail the build-size test.
 */
export { default as Editor } from './Editor.svelte';
export { default as ShowQuery } from './ShowQuery.svelte';
