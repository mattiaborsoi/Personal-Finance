import { describe, expect, it } from 'vitest';
import { trendYDomain } from './views';

describe('trendYDomain', () => {
  it('pins the axis to 0–100 when every value is zero or missing, so no £1–£4 ticks appear over nothing', () => {
    expect(trendYDomain([0, 0, 0, 0, 0, 0])).toEqual([0, 100]);
    expect(trendYDomain([Number.NaN, 0, -0])).toEqual([0, 100]);
    expect(trendYDomain([])).toEqual([0, 100]);
  });

  it('lets the chart fit the data as soon as there is any', () => {
    expect(trendYDomain([0, 0, 12.5])).toEqual(['auto', 'auto']);
    expect(trendYDomain([-100, 0])).toEqual(['auto', 'auto']);
  });
});
