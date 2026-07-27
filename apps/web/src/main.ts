import { mount } from 'svelte';
import App from './App.svelte';
import './theme.css';
import './lib/layout.css';

// The remembered theme override is applied by the inline script in index.html —
// before first paint, which no module in this graph can guarantee.

const target = document.getElementById('app');
if (!target) throw new Error('missing #app mount point');

mount(App, { target });
