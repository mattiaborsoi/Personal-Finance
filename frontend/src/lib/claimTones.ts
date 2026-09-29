import type { ClaimType } from '../api';

/**
 * The colour of each claim type: a soft fill with text in the matching colour
 * (5.5:1 or better in both themes). Written out in full so Tailwind keeps them.
 */
const TONES: Record<string, string> = {
  personal: 'bg-claim-personal-soft text-claim-personal',
  shared_proportional: 'bg-claim-income-soft text-claim-income',
  shared_equal: 'bg-claim-equal-soft text-claim-equal',
  primary_personal: 'bg-claim-primary-soft text-claim-primary',
  secondary_personal: 'bg-claim-secondary-soft text-claim-secondary',
};

/** Fill and text classes for a claim type; neutral for anything unknown. */
export function claimTone(claimType: ClaimType | string | null | undefined): string {
  return (claimType && TONES[claimType]) || TONES.personal;
}
