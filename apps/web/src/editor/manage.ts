/**
 * The dashboard-library management chunk's entry (the same code-split
 * discipline as the editor chunk, docs/05 § What editability costs): renaming,
 * duplicating, resetting and deleting dashboards is admin chrome nobody
 * reaching a dashboard needs on the view path, so it loads on first use —
 * via `import('./manage.ts')` only, never a static import from view-path code.
 */
export { default as Manage } from './ManageDashboards.svelte';
