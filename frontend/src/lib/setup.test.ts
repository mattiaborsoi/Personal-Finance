import { describe, expect, it } from 'vitest';
import { setupIncomplete, setupSteps } from './setup';

describe('setupSteps', () => {
  it('marks nothing done on a fresh install', () => {
    const steps = setupSteps(false, 0, 0);
    expect(steps.map((s) => [s.id, s.to, s.done])).toEqual([
      ['household', '/settings?tab=household', false],
      ['accounts', '/settings?tab=accounts', false],
      ['upload', '/upload', false],
    ]);
    expect(setupIncomplete(steps)).toBe(true);
  });

  it('is complete once the household is saved, an account exists and a statement is in', () => {
    expect(setupIncomplete(setupSteps(true, 1, 0))).toBe(true);
    expect(setupIncomplete(setupSteps(true, 2, 3))).toBe(false);
    expect(setupIncomplete(null)).toBe(false);
  });
});
