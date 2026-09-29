import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaimType } from '../api';
import { claimTypeValue, renderWithProviders, secondarySession } from '../test/utils';
import { ClaimTypeControl } from './ClaimTypeControl';

function Harness({ initial, onChange, disabled }: { initial: ClaimType | null; onChange: (c: ClaimType) => void; disabled?: boolean }) {
  const [value, setValue] = useState<ClaimType | null>(initial);
  return (
    <>
      <button type="button">Before</button>
      <ClaimTypeControl
        label="Claim type for Ocado"
        value={value}
        disabled={disabled}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
      <button type="button">After</button>
    </>
  );
}

const group = () => screen.getByRole('radiogroup', { name: 'Claim type for Ocado' });
const radio = (name: string) => within(group()).getByRole('radio', { name });

describe('<ClaimTypeControl />', () => {
  it("says exactly what each choice does on this line's card", () => {
    // A line on Sam's card, paid by Sam.
    renderWithProviders(
      <ClaimTypeControl label="Claim type for Ocado" value="personal" onChange={vi.fn()} context={{ payer: 'secondary', holder: 'secondary' }} />,
    );
    const g = screen.getByRole('radiogroup', { name: 'Claim type for Ocado' });
    expect(within(g).getByRole('radio', { name: "Mine (Alex's personal item)" })).toHaveAccessibleDescription(
      "Only Alex's, but Sam paid. Alex pays Sam back in full.",
    );
    expect(within(g).getByRole('radio', { name: 'Personal (not shared)' })).toHaveAccessibleDescription(
      "Sam's own spending on Sam's card. Nothing to settle.",
    );
  });

  it('is a radio group named like the select it replaces, one radio per configured claim type', () => {
    renderWithProviders(<Harness initial="shared_equal" onChange={vi.fn()} />);

    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Personal (not shared)',
      'Split by income',
      '50/50',
      "Sam's personal item",
      "Mine (Alex's personal item)",
    ]);
    // Each segment's full label is its tooltip too.
    expect(radio('Split by income')).toHaveAttribute(
      'title',
      'Split by income. Shared by both of you, split in proportion to income.',
    );
    // What each choice does is also its accessible description.
    expect(radio("Sam's personal item")).toHaveAccessibleDescription(
      "Only Sam's, whoever paid. If Alex paid, Sam pays Alex back in full.",
    );
    expect(radio('50/50')).toHaveAttribute('aria-checked', 'true');
    // The chosen segment wears its claim type's colour; the others stay neutral.
    expect(radio('50/50')).toHaveClass('bg-claim-equal-soft', 'text-claim-equal');
    expect(radio('Split by income')).not.toHaveClass('bg-claim-income-soft');
    expect(radio('Split by income')).toHaveAttribute('aria-checked', 'false');
    expect(claimTypeValue(group())).toBe('shared_equal');
    // Only the chosen segment shows its word; the others are icons with names.
    expect(radio('50/50')).toHaveTextContent('50/50');
    expect(radio('Split by income').textContent).toBe('');
    // A person's own items show their initial, so the two people are told apart without the word.
    expect(radio("Sam's personal item")).toHaveTextContent('S');
    expect(radio("Mine (Alex's personal item)")).toHaveTextContent('A');
  });

  it('calls the other person by their first name, and the viewer’s own "Mine"', () => {
    renderWithProviders(<Harness initial="secondary_personal" onChange={vi.fn()} />, { session: secondarySession });
    expect(radio("Mine (Sam's personal item)")).toHaveTextContent('Mine');
    expect(radio("Alex's personal item")).toBeInTheDocument();
  });

  it('has one tab stop, on the checked radio, or on the first when none is checked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial="shared_equal" onChange={vi.fn()} />);
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(radio('50/50')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(within(group()).getAllByRole('radio').filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('starts on the first radio when the line has no claim type yet', () => {
    renderWithProviders(<Harness initial={null} onChange={vi.fn()} />);
    expect(claimTypeValue(group())).toBe('');
    expect(radio('Personal (not shared)')).toHaveAttribute('tabindex', '0');
  });

  it('moves and chooses with the arrow keys, wrapping at either end, and Home and End', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness initial="shared_equal" onChange={onChange} />);

    radio('50/50').focus();
    await user.keyboard('{ArrowRight}');
    expect(radio("Sam's personal item")).toHaveFocus();
    expect(radio("Sam's personal item")).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith('secondary_personal');

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowRight}');
    expect(radio('Personal (not shared)')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('personal');

    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('primary_personal');
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('personal');
    await user.keyboard('{End}');
    expect(claimTypeValue(group())).toBe('primary_personal');
    await user.keyboard('{ArrowUp}');
    expect(claimTypeValue(group())).toBe('secondary_personal');
  });

  it('chooses with a click, and not again for the one already chosen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness initial="shared_equal" onChange={onChange} />);

    await user.click(radio('50/50'));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(radio('Split by income'));
    expect(onChange).toHaveBeenCalledWith('shared_proportional');
    expect(radio('Split by income')).toHaveTextContent('By income');
  });

  it('does nothing while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness initial="shared_equal" onChange={onChange} disabled />);
    within(group())
      .getAllByRole('radio')
      .forEach((r) => expect(r).toBeDisabled());
    await user.click(radio('Split by income'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
