import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, type TabItem } from './Tabs';

type Id = 'accounts' | 'household' | 'rules' | 'system';

const tabs: ReadonlyArray<TabItem<Id>> = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'household', label: 'Household' },
  { id: 'rules', label: 'Rules' },
  { id: 'system', label: 'System' },
];

function Harness({ initial }: { initial: Id }) {
  const [active, setActive] = useState<Id>(initial);
  return (
    <Tabs tabs={tabs} active={active} onChange={setActive} label="Settings sections">
      <p>{active} panel</p>
    </Tabs>
  );
}

/** jsdom has no scrollIntoView; stub one that records which element it was called on. */
function stubScrollIntoView() {
  const scrolled: Element[] = [];
  const spy = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: spy });
  return { spy, scrolled, restore: () => delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView };
}

describe('<Tabs />', () => {
  it('scrolls the active tab into view when it mounts and when it changes', async () => {
    const user = userEvent.setup();
    const { spy, scrolled, restore } = stubScrollIntoView();
    try {
      render(<Harness initial="system" />);
      expect(spy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      expect(scrolled[scrolled.length - 1]).toBe(screen.getByRole('tab', { name: 'System' }));

      await user.click(screen.getByRole('tab', { name: 'Rules' }));
      expect(scrolled[scrolled.length - 1]).toBe(screen.getByRole('tab', { name: 'Rules' }));
      expect(screen.getByText('rules panel')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('renders without scrollIntoView (jsdom) and keeps arrow key navigation', async () => {
    const user = userEvent.setup();
    render(<Harness initial="accounts" />);

    const accounts = screen.getByRole('tab', { name: 'Accounts' });
    expect(accounts).toHaveAttribute('aria-selected', 'true');
    accounts.focus();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'System' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(accounts).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByText('system panel')).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(screen.getByText('accounts panel')).toBeInTheDocument();
  });
});
