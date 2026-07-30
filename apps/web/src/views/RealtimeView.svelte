<script lang="ts">
import type { VizType, WidgetSpec } from '@featherstat/shared';
import { FEED_SHOW } from '../lib/realtime.ts';
import type { SiteScope } from '../lib/state.ts';
import ActiveNow from '../widgets/ActiveNow.svelte';
import Feed from '../widgets/Feed.svelte';
import RealtimeCountries from '../widgets/RealtimeCountries.svelte';
import type { AppEnv, WidgetEnv } from '../widgets/types.ts';
import VisitorTally from '../widgets/VisitorTally.svelte';

/**
 * The Realtime view (docs/05): active-now hero, who is here (with each
 * visitor's trail), the live feed, and the 30-minute country tally — pure SSE,
 * zero `/api/query` traffic. It COMPOSES the registered realtime widgets
 * rather than rendering their innards (CLAUDE.md invariant 7), so the same
 * pieces drop onto any dashboard; what lives here is the page's own
 * arrangement and the highlight the tally and feed share.
 */
interface Props {
  app: AppEnv;
  site: SiteScope;
}

let { app, site }: Props = $props();

/** Alias under the cursor — its every row lights up, feed and tally alike. */
let hover = $state<string | undefined>(undefined);

/** Clock for the `ago` labels and the tally window — ticks while the view is up. */
let now = $state(Date.now());
$effect(() => {
  const timer = setInterval(() => {
    now = Date.now();
  }, 10_000);
  return () => clearInterval(timer);
});

/**
 * This page's environment. It says out loud what it withholds: `data: null`,
 * because the realtime family asks the batch for nothing, and no windows or
 * range because nothing here is bucketed. What it adds is the shared highlight
 * — the one thing a page that arranges widgets by hand owns.
 */
const env = $derived<WidgetEnv>({
  ...app,
  data: null,
  windows: null,
  rangeLabel: null,
  scope: site,
  now,
  onfilter: null,
  headless: false,
  highlight: { name: hover, onhover: (name) => (hover = name) },
});

/** Spec stand-ins: on this page the arrangement is the page's, not a document's
 * — including how long the feed runs, which is the widget's own option. */
const cardSpec = (id: string, viz: VizType, options: Record<string, unknown> = {}): WidgetSpec => ({
  id,
  viz,
  w: 6,
  h: 2,
  options,
});
</script>

<div class="filters">
  <span class="compare-note">Live — every hit as it lands · one stream, no queries</span>
</div>

<div class="grid">
  <div class="card c6">
    <h2>Right now</h2>
    <ActiveNow spec={cardSpec('active', 'active-now')} {env} />
    <VisitorTally spec={cardSpec('tally', 'visitor-tally')} {env} />
    <!-- Headless: the card's heading is this page's, and the empty state is the
         widget's own — the view decides nothing the feed already decides. -->
    <Feed spec={cardSpec('feed', 'feed', { limit: FEED_SHOW })} env={{ ...env, headless: true }} />
  </div>

  <div class="card c6">
    <RealtimeCountries spec={cardSpec('countries', 'realtime-countries')} {env} />
  </div>
</div>
