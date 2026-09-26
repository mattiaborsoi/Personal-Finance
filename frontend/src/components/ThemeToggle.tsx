import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { applyTheme, nextTheme, readStoredTheme, storeTheme, type Theme } from '../lib/theme';
import { btnIcon, cx } from '../lib/ui';

const LABELS: Record<Theme, string> = {
  system: 'Theme: follows your system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/** Cycles light → dark → system. The choice is remembered on this device. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  function cycle() {
    const next = nextTheme(theme);
    setTheme(next);
    storeTheme(next);
    applyTheme(next);
  }

  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <button
      type="button"
      className={cx(btnIcon, className)}
      onClick={cycle}
      aria-label={`${LABELS[theme]}. Switch theme`}
      title={LABELS[theme]}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
