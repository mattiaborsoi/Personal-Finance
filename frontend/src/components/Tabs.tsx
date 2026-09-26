import type { LucideIcon } from 'lucide-react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx, focusRing } from '../lib/ui';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
}

interface Props<T extends string> {
  tabs: ReadonlyArray<TabItem<T>>;
  active: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list, e.g. "Settings sections". */
  label: string;
  /** The active tab's panel. */
  children: ReactNode;
}

/**
 * Accessible tabs: roving focus with the arrow keys, Home and End, and a
 * tab selects as soon as it is focused. The caller owns the active id (a
 * URL parameter, say) and renders the panel's content.
 */
export function Tabs<T extends string>({ tabs, active, onChange, label, children }: Props<T>) {
  const idBase = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabId = (id: string) => `${idBase}-tab-${id}`;
  const panelId = `${idBase}-panel`;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next].id);
    buttons.current[next]?.focus();
  }

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-hairline">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cx(
                '-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                focusRing,
                selected ? 'border-brand text-brand-strong' : 'border-transparent text-ink-2 hover:border-hairline-strong hover:text-ink',
              )}
            >
              {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(active)}>
        {children}
      </div>
    </div>
  );
}
