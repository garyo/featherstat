import { describe, expect, it } from 'vitest';
import { claimLinkFromPath } from './welcome.ts';

const TOKEN = 'A'.repeat(43);

describe('claimLinkFromPath', () => {
  it('recognizes user invites and viewer magic links by path and prefix', () => {
    expect(claimLinkFromPath(`/welcome/fsu_${TOKEN}`)).toEqual({
      kind: 'user',
      token: `fsu_${TOKEN}`,
    });
    expect(claimLinkFromPath(`/invite/fsv_${TOKEN}/`)).toEqual({
      kind: 'viewer',
      token: `fsv_${TOKEN}`,
    });
  });

  it('refuses a token under the wrong path, a short token, and every other path', () => {
    for (const path of [
      `/welcome/fsv_${TOKEN}`,
      `/invite/fsu_${TOKEN}`,
      '/invite/fsv_short',
      '/',
      `/s/${TOKEN}`,
    ]) {
      expect(claimLinkFromPath(path), path).toBeUndefined();
    }
  });
});
