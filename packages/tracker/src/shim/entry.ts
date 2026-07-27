import { startShim } from './browser.ts';

// Bundle entry for `/matomo.js` (alias `/piwik.js`): loading the script is the
// whole API — the page talks to it through `_paq`.
startShim();
