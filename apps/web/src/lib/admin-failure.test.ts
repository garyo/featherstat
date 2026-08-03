import { describe, expect, it } from 'vitest';
import { AdminError, OFFLINE_STATUS } from './admin.ts';
import { panelFailure, SIGNED_OUT_MESSAGE, UNREACHABLE_MESSAGE } from './admin-failure.ts';

/**
 * The mapping a panel renders. The two urgent cases are the ones that shipped a
 * lie: a revoke refused with 401 that the panel showed as nothing at all.
 */

describe('panelFailure', () => {
  it.each([401, 403])('reads %d as a lost session, urgently', (status) => {
    expect(panelFailure(new AdminError(status, 'unauthorized'), 'nope')).toEqual({
      message: SIGNED_OUT_MESSAGE,
      urgent: true,
    });
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
