<script lang="ts">
import { DISTINCT_NOTE } from './format.ts';

/**
 * The mark a distinct count wears (docs/03 § Visitor identity, docs/05 §
 * Numbers): exact within a day, an approximation over a longer range, because
 * the visitor hash is salted with a salt that rotates at 00:00 UTC.
 *
 * One rendering of it, decorated by its callers — the KPI tile's label and the
 * site card's caption both show this rather than each spelling out a tilde and
 * a tooltip of their own.
 */
</script>

<span class="approx" title={DISTINCT_NOTE}>~<span class="sr">{DISTINCT_NOTE}</span></span>

<style>
  .approx {
    color: var(--muted);
    /* A caveat, not a character of the label it follows. */
    margin-left: 0.15em;
    cursor: help;
  }

  .sr {
    /* The tooltip is a pointer affordance; the sentence itself stays readable
       to a screen reader (docs/05 § Accessibility). */
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
