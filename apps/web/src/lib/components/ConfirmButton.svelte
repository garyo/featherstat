<script lang="ts" module>
/** Long enough to read a question that names what it destroys; short enough to lapse. */
export const CONFIRM_WINDOW_MS = 5_000;
</script>

<script lang="ts">
/**
 * The app's one gate for an action that cannot be undone: the first click arms
 * the button and it asks, in its own label, whether it should; only a second
 * click acts. It disarms by itself after `CONFIRM_WINDOW_MS` or on Escape, so a
 * stray click long after cannot land. While the action runs the button is
 * disabled, so a double-click can never send the request twice.
 *
 * `onconfirm` owns its own failure reporting — the rows this sits in already
 * say what went wrong beside them (PanelError).
 */
interface Props {
  /** What the action is, at rest: "Delete", "Revoke". */
  label: string;
  /** The armed question, which says what will be lost: "Really delete + scrub?". */
  confirm: string;
  /** While the action runs; the label if omitted. */
  pending?: string;
  /** Button classes — the button is a `.btn` like any other. */
  class?: string;
  disabled?: boolean;
  /** Readable by a parent that says more while the question stands. */
  armed?: boolean;
  onconfirm: () => Promise<void> | void;
}

let {
  label,
  confirm,
  pending,
  class: className = 'btn subtle',
  disabled = false,
  armed = $bindable(false),
  onconfirm,
}: Props = $props();

let busy = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function disarm(): void {
  clearTimeout(timer);
  armed = false;
}

async function click(): Promise<void> {
  if (busy) return;
  if (!armed) {
    armed = true;
    timer = setTimeout(disarm, CONFIRM_WINDOW_MS);
    return;
  }
  disarm();
  busy = true;
  try {
    await onconfirm();
  } finally {
    busy = false;
  }
}

$effect(() => () => clearTimeout(timer));
</script>

<button
  class={className}
  class:armed
  type="button"
  disabled={disabled || busy}
  onclick={() => void click()}
  onkeydown={(event) => {
    // Answering "no" to the question, not to the dialog the button sits in.
    if (event.key === 'Escape' && armed) {
      event.preventDefault();
      event.stopPropagation();
      disarm();
    }
  }}
>
  {busy ? (pending ?? label) : armed ? confirm : label}
</button>
<span class="said" role="status">{armed ? `${confirm} Press again to confirm.` : ''}</span>

<style>
  button.armed {
    color: var(--bad);
  }

  /* Heard, not seen: the button's own label already shows the question. */
  .said {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
