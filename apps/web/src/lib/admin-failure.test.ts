import { describe, expect, it } from 'vitest';
import { AdminError, OFFLINE_STATUS } from './admin.ts';
import {
  notAllowedMessage,
  panelFailure,
  SIGNED_OUT_MESSAGE,
  UNREACHABLE_MESSAGE,
} from './admin-failure.ts';

/**
 * The mapping a panel renders. The two urgent cases are the ones that shipped a
 * lie: a revoke refused with 401 that the panel showed as nothing at all.
 */

describe('panelFailure', () => {
  it('reads 401 as a lost session, urgently', () => {
    expect(panelFailure(new AdminError(401, 'unauthorized'), 'nope')).toEqual({
      message: SIGNED_OUT_MESSAGE,
      urgent: true,
    });
  });

  // A signed-in user refused an admin-only write was told to log in again.
  it('reads 403 as a refusal of this account, with the server’s reason', () => {
    expect(panelFailure(new AdminError(403, 'admin only'), 'nope')).toEqual({
      message: notAllowedMessage('admin only'),
      urgent: true,
    });
    expect(notAllowedMessage('admin only')).not.toContain('signed in');
  });

  it('reads an unanswered request as an unreachable server, urgently', () => {
    expect(panelFailure(new AdminError(OFFLINE_STATUS, 'no response'), 'nope')).toEqual({
      message: UNREACHABLE_MESSAGE,
      urgent: true,
    });
  });

  it('keeps the server’s own words for a refusal the form can fix', () => {
    expect(panelFailure(new AdminError(400, 'name is too long'), 'Saving failed.')).toEqual({
      message: 'name is too long',
      urgent: false,
    });
    expect(panelFailure(new Error('boom'), 'Saving failed.')).toEqual({
      message: 'boom',
      urgent: false,
    });
  });

  it('falls back when what was thrown is not an Error at all', () => {
    expect(panelFailure('weird', 'Saving failed.')).toEqual({
      message: 'Saving failed.',
      urgent: false,
    });
  });
});
