// Blocking, before the stylesheet paints: a remembered theme override must beat
// the OS preference on the very first frame (src/lib/theme.ts owns the key;
// docs/05 R12). A file rather than an inline script: the CSP is script-src 'self'.
var theme = null;
try {
  theme = localStorage.getItem('theme');
} catch {}
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
