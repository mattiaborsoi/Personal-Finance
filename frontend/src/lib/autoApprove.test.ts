import { describe, expect, it } from 'vitest';
import { knownMerchantsSentence, staysBreakdown } from './autoApprove';

describe('auto-approve wording', () => {
  it('lists what stays in a fixed order, leaving out empty reasons', () => {
    expect(staysBreakdown({ other_sign: 3, new_merchant: 330, unusual_amount: 9, mixed_history: 51, split: 0 })).toBe(
      'New merchants 330 · Filed different ways 51 · Unusual amount 9 · Other sign 3',
    );
    expect(staysBreakdown({})).toBe('');
  });

  it('counts the lines before and after the run', () => {
    expect(knownMerchantsSentence(12)).toBe('12 lines from merchants you know can be approved');
    expect(knownMerchantsSentence(12, true)).toBe('12 lines from merchants you know were approved');
    expect(knownMerchantsSentence(1, true)).toBe('1 line from merchants you know was approved');
    expect(knownMerchantsSentence(0)).toBe('No lines from merchants you know can be approved');
  });
});
