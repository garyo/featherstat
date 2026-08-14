/**
 * The invite-claim page's code-split chunk entry: `main.ts` imports it only
 * when the URL is a `/welcome/<token>` link, so the authenticated app's
 * startup never runs for an invitee who has no session yet.
 */
export { default as WelcomeView } from './WelcomeView.svelte';
