import { it } from 'vitest';

/**
 * A wall-clock assertion, where the machine is part of the assertion.
 *
 * These exist to catch an algorithmic blowup — an accidental O(n²) reads in
 * seconds, not milliseconds — so their thresholds carry enough headroom to
 * ignore scheduler moods on the machine they were measured on, and no more.
 * A shared CI runner is 1.2–1.5× slower than that machine, which spends the
 * headroom on hardware and leaves the guard measuring the runner: dwell's
 * 250 ms allowance, against a local 60–120 ms, failed at 270.8 ms on
 * `ubuntu-latest` while the code was unchanged and correct.
 *
 * Restating the numbers for the slowest machine that might ever run them would
 * cost the blowup detection they exist for, which is the whole asset — a budget
 * loose enough to pass anywhere catches nothing anywhere. Invariant 6 forbids
 * loosening them regardless. So they stay strict and stay where they were
 * calibrated: the pre-push hook, which is where a regression is cheapest to
 * hear about. `scripts/ci.sh` skips the replay bench under $CI for the same
 * reason and announces the skip in its summary rather than quietly passing.
 *
 * The cost is real and worth naming: a perf regression pushed without the hook
 * installed reaches main unchallenged. Detecting one in CI needs a baseline
 * calibrated to CI's own hardware, not a wider number here.
 */
export const itWhereCalibrated = it.skipIf(onCi());

/**
 * `$CI` set and non-empty — the same test `scripts/ci.sh` makes (`-n "${CI:-}"`)
 * before skipping the bench, so `CI=` cannot skip one half and run the other.
 */
function onCi(): boolean {
  return (process.env.CI ?? '') !== '';
}
