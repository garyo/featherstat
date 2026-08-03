import { describe, expect, it } from 'vitest';
import { bearerCredential } from './bearer.ts';

describe('bearerCredential', () => {
  it('reads every spelling of the scheme — it is case-insensitive (RFC 7235)', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      expect(bearerCredential(`${scheme} fs_abc`)).toBe('fs_abc');
    }
  });

  it('returns the credential verbatim — a base64url token must not be folded', () => {
    expect(bearerCredential('bearer Fs_AbC-_9')).toBe('Fs_AbC-_9');
  });

  it('accepts the 1*SP the grammar allows', () => {
    expect(bearerCredential('Bearer   fs_abc')).toBe('fs_abc');
  });

  it('is not another scheme, and not a word that merely starts the same', () => {
    for (const header of [undefined, '', 'Basic fs_abc', 'Bearerish fs_abc', 'Bearer', 'fs_abc']) {
      expect(bearerCredential(header)).toBeUndefined();
    }
  });
});
