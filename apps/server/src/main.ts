import { serve } from '@hono/node-server';
import { createApp } from './index.ts';

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: createApp().fetch, port });
console.log(`analytics server listening on :${port}`);
