import { describe, expect, it } from 'vitest';
import { keyStep } from './keys.ts';

describe('keyStep', () => {
  it('steps one with the arrows and jumps to the ends with Home and End', () => {
    expect(keyStep('ArrowLeft', 3, 8)).toBe(2);
    expect(keyStep('ArrowUp', 3, 8)).toBe(2);
    expect(keyStep('ArrowRight', 3, 8)).toBe(4);
    expect(keyStep('ArrowDown', 3, 8)).toBe(4);
    expect(keyStep('Home', 3, 8)).toBe(0);
    expect(keyStep('End', 3, 8)).toBe(7);
  });

  it('stops at the ends rather than wrapping', () => {
    expect(keyStep('ArrowLeft', 0, 8)).toBe(0);
    expect(keyStep('ArrowRight', 7, 8)).toBe(7);
  });

  it('leaves every other key, and an empty list, alone', () => {
    expect(keyStep('Enter', 3, 8)).toBeUndefined();
    expect(keyStep('a', 3, 8)).toBeUndefined();
    expect(keyStep('End', 0, 0)).toBeUndefined();
  });
});
