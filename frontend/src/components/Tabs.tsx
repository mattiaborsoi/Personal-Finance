import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
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

/** How far the strip fades out at an edge that has more tabs beyond it. */
const FADE = '1.5rem';

/** A mask that fades the strip out at whichever edges hide more tabs; background-agnostic, so it suits both themes. */
function fadeMask(start: boolean, end: boolean): CSSProperties | undefined {
  if (!start && !end) return undefined;
  const image = `linear-gradient(to right, ${start ? 'transparent' : '#000'}, #000 ${start ? FADE : '0px'}, #000 calc(100% - ${end ? FADE : '0px'}), ${end ? 'transparent' : '#000'})`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * Accessible tabs: roving focus with the arrow keys, Home and End, and a
 * tab selects as soon as it is focused. The caller owns the active id (a
 * URL parameter, say) and renders the panel's content.
 *
 * On a narrow screen the strip scrolls sideways: the active tab is scrolled
 * into view when it mounts and whenever it changes, and an edge fades out
 * while there are more tabs beyond it.
 */
export function Tabs<T extends string>({ tabs, active, onChange, label, children }: Props<T>) {
  const idBase = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabId = (id: string) => `${idBase}-tab-${id}`;
  const panelId = `${idBase}-panel`;
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Keep the fades in step with the strip's width (a rotated phone, a resized window).
  useEffect(() => {
    measure();
    const el = strip.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // The selected tab may sit past the edge of a phone's screen (a deep link to ?tab=system).
  const activeIndex = tabs.findIndex((tab) => tab.id === active);
  useEffect(() => {
    const button = buttons.current[activeIndex];
    // jsdom has no layout, and no scrollIntoView.
    if (button && typeof button.scrollIntoView === 'function') {
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    measure();
  }, [activeIndex, measure]);

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
      <div
        ref={strip}
        role="tablist"
        aria-label={label}
        className="flex scroll-px-6 gap-1 overflow-x-auto border-b border-hairline"
        style={fadeMask(overflow.start, overflow.end)}
        onScroll={measure}
      >
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
