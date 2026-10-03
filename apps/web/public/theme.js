var theme = null;
try {
  theme = localStorage.getItem('theme');
} catch {}
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
