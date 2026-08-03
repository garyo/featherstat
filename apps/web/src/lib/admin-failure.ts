import { AdminError, OFFLINE_STATUS } from './admin.ts';

/**
 * What a settings panel says when a mutation fails, and how loudly.
 *
 * A revoke that came back 401 looked exactly like a revoke that worked: the row
 * reloaded from a list the server also refused, and nothing said the session had
 * expired. Two failures are not the form's fault and cannot be retried into
 * working — an expired session and an unreachable server — so they get their own
 * wording and render `urgent` (boxed, beside the button that was clicked).
 * Everything else keeps the server's own message.
 */

export const SIGNED_OUT_MESSAGE =
  'Not signed in — your session may have expired. Reload to log back in.';
export const UNREACHABLE_MESSAGE = 'Could not reach the server — is it running?';

export interface PanelFailure {
  message: string;
  /** Nothing on this form can fix it — say so unmissably. */
  urgent: boolean;
}

export function panelFailure(failure: unknown, fallback: string): PanelFailure {
  const status = failure instanceof AdminError ? failure.status : undefined;
  if (status === 401 || status === 403) return { message: SIGNED_OUT_MESSAGE, urgent: true };
  if (status === OFFLINE_STATUS) return { message: UNREACHABLE_MESSAGE, urgent: true };
  return { message: failure instanceof Error ? failure.message : fallback, urgent: false };
}
