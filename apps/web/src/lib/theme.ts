/**
 * Light/dark is the OS preference until the reader overrides it; the override is
 * a `data-theme` stamp on `<html>`, which `theme.css` lets win in both
 * directions (docs/05 R12 — a selected dark palette, not an inversion).
 */

export type Theme = 'light' | 'dark';

/** Also read by the inline pre-paint script in index.html — keep the two in sync. */
const STORAGE_KEY = 'theme';

/** What the reader is actually seeing: the override if there is one, else the OS preference. */
function resolvedTheme(): Theme {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === 'light' || stamped === 'dark') return stamped;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  write(next);
  return next;
}

function write(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // storage blocked: the choice holds for this page, just not the next one
  }
}
