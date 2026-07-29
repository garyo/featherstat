import { describe, expect, it } from 'vitest';
import { binId, T0, VISITOR } from '../../test/rows.ts';
import { VisitorAliaser } from './alias.ts';

const DAY_MS = 86_400_000;

/**
 * The two halves of a wire visitor, and why they are two: the NAME is derived
 * from the day and the id, so it is stable, re-mints at midnight, and collides
 * (384 labels for any number of visitors). The REF is minted from a
 * per-process salt, so it is exact, survives the midnight re-mint, and means
 * nothing outside this process. Rows key on the ref; only humans read the name.
 */
describe('visitor ref', () => {
  it('is stable for one visitor, distinct between visitors, and not the id', () => {
    const aliaser = new VisitorAliaser();
    const first = aliaser.alias(VISITOR, T0);
    const again = aliaser.alias(VISITOR, T0 + 3_600_000);
    const other = aliaser.alias(binId(9), T0);

    expect(first.ref).toMatch(/^[0-9a-f]{12}$/);
    expect(again.ref).toBe(first.ref);
    expect(other.ref).not.toBe(first.ref);
    // Not the stored id, nor a prefix of it: the wire must not carry identity.
    expect(first.ref).not.toContain(Buffer.from(VISITOR).toString('hex').slice(0, 8));
  });

  it('is ephemeral: a new process mints a new ref for the same visitor', () => {
    const before = new VisitorAliaser().alias(VISITOR, T0);
    const after = new VisitorAliaser().alias(VISITOR, T0);
    expect(after.name).toBe(before.name); // the label is derived, so it survives
    expect(after.ref).not.toBe(before.ref); // the handle is not
  });

  it('survives the day rollover that re-mints the name', () => {
    const aliaser = new VisitorAliaser();
    const today = aliaser.alias(VISITOR, T0);
    const tomorrow = aliaser.alias(VISITOR, T0 + DAY_MS);
    expect(tomorrow.name).not.toBe(today.name);
    // Same visit, same handle: a name change must not split a row mid-session.
    expect(tomorrow.ref).toBe(today.ref);
  });
});
