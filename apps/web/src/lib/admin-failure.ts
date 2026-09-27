import { AdminError, OFFLINE_STATUS } from './admin.ts';

/**
 * What a settings panel says when a mutation fails, and how loudly.
 *
 * A revoke that came back 401 looked exactly like a revoke that worked: the row
 * reloaded from a list the server also refused, and nothing said the session had
 * expired. Two failures are not the form's fault and cannot be retried into
 * working — an expired session and an unreachable server — so they get their own
 * wording and render `urgent` (boxed, beside the button that was clicked). A 403
 * is neither: the session is fine and this account may not do the thing, so it
 * says so — with the server's reason — rather than sending a signed-in reader to
 * log in again. Everything else keeps the server's own message.
 */

export const SIGNED_OUT_MESSAGE =
  'Not signed in — your session may have expired. Reload to log back in.';
export const UNREACHABLE_MESSAGE = 'Could not reach the server — is it running?';
export const notAllowedMessage = (reason: string): string => `Not allowed — ${reason}.`;

export interface PanelFailure {
  message: string;
  /** Nothing on this form can fix it — say so unmissably. */
  urgent: boolean;
}

export function panelFailure(failure: unknown, fallback: string): PanelFailure {
  if (failure instanceof AdminError) {
    if (failure.status === 401) return { message: SIGNED_OUT_MESSAGE, urgent: true };
    if (failure.status === 403)
      return { message: notAllowedMessage(failure.message), urgent: true };
    if (failure.status === OFFLINE_STATUS) return { message: UNREACHABLE_MESSAGE, urgent: true };
  }
  return { message: failure instanceof Error ? failure.message : fallback, urgent: false };
}
