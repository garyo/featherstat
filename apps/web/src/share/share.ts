/**
 * The share page's code-split chunk entry: `main.ts` imports it only when the
 * URL is a share link, so the authenticated app's startup — the `/api/admin/me`
 * probe above all — never runs for a reader who has no session.
 */
export { default as ShareView } from './ShareView.svelte';
