/**
 * The claim pages' code-split chunk entry: `main.ts` imports it only when the
 * URL is a `/welcome/<token>` or `/invite/<token>` link, so the authenticated
 * app's startup never runs for an invitee who has no session yet.
 */
export { default as InviteView } from './InviteView.svelte';
export { default as WelcomeView } from './WelcomeView.svelte';
