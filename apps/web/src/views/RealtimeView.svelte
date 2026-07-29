<script lang="ts">
import type { RealtimeEngagement, RealtimeHit, SiteInfo } from '@featherstat/shared';
import { FEED_SHOW, inScope } from '../lib/realtime.ts';
import type { SiteScope } from '../lib/state.ts';
import ActiveNow from '../widgets/ActiveNow.svelte';
import Feed from '../widgets/Feed.svelte';
import RealtimeCountries from '../widgets/RealtimeCountries.svelte';
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
  active: Record<number, number>;
  recent: readonly RealtimeHit[];
  visitorTimes: readonly RealtimeEngagement[];
  site: SiteScope;
  sites: SiteInfo[] | undefined;
}

let { active, recent, visitorTimes, site, sites }: Props = $props();

/** The widgets look sites up by id; this view is handed the directory as a list. */
const siteMap = $derived(new Map((sites ?? []).map((entry) => [entry.id, entry])));

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

const shown = $derived((recent ?? []).filter((hit) => inScope(hit, site)).slice(0, FEED_SHOW));
/** Spec stand-ins: on this page the arrangement is the page's, not a document's. */
const cardSpec = (id: string, title?: string) =>
  ({
    id,
    viz: 'feed',
    w: 6,
    h: 2,
    options: {},
    ...(title === undefined ? {} : { title }),
  }) as never;
</script>

<div class="filters">
  <span class="compare-note">Live — every hit as it lands · one stream, no queries</span>
</div>

<div class="grid">
  <div class="card c6">
    <h2>Right now</h2>
    <ActiveNow spec={cardSpec('active')} {active} scope={site} />
    <VisitorTally
      spec={cardSpec('tally')}
      {recent}
      {visitorTimes}
      scope={site}
      sites={siteMap}
      {now}
      {hover}
      onhover={(name) => (hover = name)}
    />
    {#if shown.length === 0}
      <p class="widget-note">Waiting for the first hit…</p>
    {:else}
      <Feed
        spec={cardSpec('feed')}
        {recent}
        scope={site}
        sites={siteMap}
        {hover}
        onhover={(name) => (hover = name)}
        headless
      />
    {/if}
  </div>

  <div class="card c6">
    <RealtimeCountries spec={cardSpec('countries')} {recent} scope={site} {now} />
  </div>
</div>

<style>
</style>
