import { NtfySettingsSchema } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { draftFrom, emptyRule, fieldErrors, type NtfyDraft, settingsBody } from './ntfy.ts';

const CONFIGURED: NtfyDraft = {
  url: ' https://ntfy.example.com ',
  topic: ' analytics ',
  token: '',
  clearToken: false,
  rules: [{ site: '2', eventCategory: 'signup', eventAction: '', label: ' welcome ' }],
};

describe('draftFrom', () => {
  it('fills the form from the view, with the token box empty', () => {
    expect(
      draftFrom({
        url: 'https://ntfy.example.com',
        topic: 'analytics',
        tokenSet: true,
        rules: [{ site: 3, label: 'checkout' }],
      }),
    ).toEqual({
      url: 'https://ntfy.example.com',
      topic: 'analytics',
      token: '',
      clearToken: false,
      rules: [{ site: '3', eventCategory: '', eventAction: '', label: 'checkout' }],
    });
  });

  it('starts an unconfigured install on empty fields', () => {
    expect(draftFrom({ tokenSet: false, rules: [] })).toEqual({
      url: '',
      topic: '',
      token: '',
      clearToken: false,
      rules: [],
    });
  });
});

describe('settingsBody', () => {
  it('trims, keeps only the fields a rule constrains, and passes the schema', () => {
    const { body, rows } = settingsBody(CONFIGURED);

    expect(body).toEqual({
      url: 'https://ntfy.example.com',
      topic: 'analytics',
      rules: [{ site: 2, eventCategory: 'signup', label: 'welcome' }],
    });
    expect(rows).toEqual([0]);
    expect(NtfySettingsSchema.safeParse(body).success).toBe(true);
  });

  it('drops untouched rows and remembers which rows survived', () => {
    const { body, rows } = settingsBody({
      ...CONFIGURED,
      rules: [emptyRule(), { ...emptyRule(), eventAction: 'purchase' }, emptyRule()],
    });

    expect(body.rules).toEqual([{ eventAction: 'purchase' }]);
    expect(rows).toEqual([1]);
  });

  it('replaces, clears or keeps the token — the three cases the API takes', () => {
    expect(settingsBody({ ...CONFIGURED, token: 'tk_new' }).body.token).toBe('tk_new');
    expect(settingsBody({ ...CONFIGURED, clearToken: true }).body.token).toBeNull();
    expect('token' in settingsBody(CONFIGURED).body).toBe(false);
    // A typed replacement wins: clearing is what an EMPTY box plus the flag means.
    expect(settingsBody({ ...CONFIGURED, token: 'tk_new', clearToken: true }).body.token).toBe(
      'tk_new',
    );
  });
});

describe('fieldErrors', () => {
  it('routes issues to url, topic and the draft row they came from', () => {
    const errors = fieldErrors(
      [
        { path: ['url'], message: 'must be an https URL' },
        { path: ['rules', 1, 'site'], message: 'too small' },
      ],
      [0, 3],
      'invalid request',
    );

    expect(errors.url).toBe('must be an https URL');
    expect(errors.topic).toBeUndefined();
    // Body index 1 is draft row 3 — blank rows never travelled.
    expect(errors.rules.get(3)).toBe('too small');
    expect(errors.form).toBeUndefined();
  });

  it('falls back to the response message when no issue named a field', () => {
    expect(fieldErrors([], [], 'invalid request').form).toEqual({
      message: 'invalid request',
      urgent: false,
    });
    expect(fieldErrors([{ path: [], message: 'body too large' }], [], 'x').form).toEqual({
      message: 'body too large',
      urgent: false,
    });
  });

  it('keeps the first message per field', () => {
    const errors = fieldErrors(
      [
        { path: ['topic'], message: 'first' },
        { path: ['topic'], message: 'second' },
      ],
      [],
      'invalid request',
    );

    expect(errors.topic).toBe('first');
  });
});
