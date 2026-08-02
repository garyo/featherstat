import type { AlertRule } from '@featherstat/shared';
import { describe, expect, it } from 'vitest';
import { describeCondition, draftsOf, emptyAlert, rulesOf } from './alerts.ts';

const RULE: AlertRule = {
  site: 2,
  metric: 'visits',
  condition: 'above',
  threshold: 100,
  window: 'day',
};

describe('draftsOf / rulesOf round trip', () => {
  it('survives the trip, with and without a dimension', () => {
    const rules: AlertRule[] = [
      RULE,
      { ...RULE, metric: 'events', dim: 'event_category', value: 'signup', condition: 'delta_pct' },
    ];
    expect(rulesOf(draftsOf(rules))).toEqual({ rules });
  });

  it('a fresh row already carries workable defaults', () => {
    expect(rulesOf([{ ...emptyAlert(4), threshold: '10' }])).toEqual({
      rules: [{ site: 4, metric: 'visits', condition: 'above', threshold: 10, window: 'day' }],
    });
  });
});

describe('rulesOf refusals', () => {
  it('points at the row that is wrong', () => {
    const good = { ...emptyAlert(1), threshold: '5' };
    expect(rulesOf([good, { ...emptyAlert(), threshold: '5' }])).toEqual({
      error: 'pick a site',
      row: 1,
    });
    expect(rulesOf([{ ...good, threshold: 'lots' }])).toMatchObject({ row: 0 });
    expect(rulesOf([{ ...good, metric: 'velocity' }])).toMatchObject({ row: 0 });
    expect(rulesOf([{ ...good, dim: 'not-a-dim', value: 'x' }])).toMatchObject({ row: 0 });
  });

  it('requires the dimension and value to travel together', () => {
    const good = { ...emptyAlert(1), threshold: '5' };
    expect(rulesOf([{ ...good, dim: 'country', value: '' }])).toEqual({
      error: 'a dimension and its value come together',
      row: 0,
    });
  });
});

describe('describeCondition', () => {
  it('reads each comparison back in words', () => {
    expect(describeCondition(RULE)).toBe('above 100 (today)');
    expect(describeCondition({ ...RULE, condition: 'delta_pct', window: 'hour' })).toBe(
      'moves more than 100% (last 24h)',
    );
  });
});
