import { describe, expect, it } from 'vitest';
import { shareEndpoint, shareLink, shareTokenFromPath } from './share.ts';

const TOKEN = 'a'.repeat(43);

describe('shareTokenFromPath', () => {
  it('accepts both the link path and the endpoint path', () => {
    expect(shareTokenFromPath(`/s/${TOKEN}`)).toBe(TOKEN);
    expect(shareTokenFromPath(`/share/${TOKEN}`)).toBe(TOKEN);
    expect(shareTokenFromPath(`/s/${TOKEN}/`)).toBe(TOKEN);
  });

  it('is undefined for every other path, so the app mounts as usual', () => {
    for (const path of ['/', '/settings', `/s/${TOKEN}/extra`, '/s/', `/s/${'a'.repeat(42)}`]) {
      expect(shareTokenFromPath(path)).toBeUndefined();
    }
  });

  it('refuses tokens outside the server alphabet', () => {
    expect(shareTokenFromPath(`/s/${'a'.repeat(42)}!`)).toBeUndefined();
    expect(shareTokenFromPath(`/s/${'a'.repeat(42)}.`)).toBeUndefined();
  });
});

describe('link building', () => {
  it('builds a copyable absolute link', () => {
    expect(shareLink('https://analytics.example.com', TOKEN)).toBe(
      `https://analytics.example.com/s/${TOKEN}`,
    );
    expect(shareLink('https://analytics.example.com/', TOKEN)).toBe(
      `https://analytics.example.com/s/${TOKEN}`,
    );
  });

  it('points the fetch at the JSON endpoint', () => {
    expect(shareEndpoint(TOKEN)).toBe(`/share/${TOKEN}`);
  });
});
