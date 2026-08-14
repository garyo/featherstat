import { mount } from 'svelte';
import App from './App.svelte';
import { shareTokenFromPath } from './lib/share.ts';
import { welcomeTokenFromPath } from './lib/welcome.ts';
import './theme.css';
import './lib/layout.css';
import './lib/forms.css';

// The remembered theme override is applied by the inline script in index.html —
// before first paint, which no module in this graph can guarantee.

const target = document.getElementById('app');
if (!target) throw new Error('missing #app mount point');

const shareToken = shareTokenFromPath(window.location.pathname);
const welcomeToken = welcomeTokenFromPath(window.location.pathname);
if (welcomeToken !== undefined) {
  // An invite claim carries no session either: same pre-auth mount as share.
  void import('./welcome/welcome.ts').then(({ WelcomeView }) =>
    mount(WelcomeView, { target, props: { token: welcomeToken } }),
  );
} else if (shareToken === undefined) {
  mount(App, { target });
} else {
  // A share link carries no session: the read-only page is its own chunk, and
  // the authenticated app — the `/api/admin/me` probe, the SSE stream, the
  // query client — never starts for a reader who cannot use any of it.
  void import('./share/share.ts').then(({ ShareView }) =>
    mount(ShareView, { target, props: { token: shareToken } }),
  );
}
