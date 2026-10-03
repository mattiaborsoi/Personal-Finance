import { MoveHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/ui';

interface Props {
  children: ReactNode;
  className?: string;
}

/**
 * A wide table scrolls sideways inside its card rather than widening the page; on a
 * phone, where that is easy to miss, a one-line hint says so while there is more to see.
 */
export function TableScroller({ children, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={className}>
      <div ref={ref} className="overflow-x-auto">
        {children}
      </div>
      {overflowing && (
        <p className={cx('mt-2 flex items-center gap-1.5 text-xs text-ink-3 sm:hidden')} data-testid="scroll-hint">
          <MoveHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Swipe sideways to see the whole table
        </p>
      )}
    </div>
  );
}
