/** Theme preference: light, dark, or follow the operating system. */

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'pf.theme';

export function readStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // storage unavailable: fall through
  }
  return 'system';
}

export function storeTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore
  }
}

/** Browser-chrome colours; keep in sync with --color-bg in src/index.css (light 247 247 244, dark 15 15 14). */
const THEME_COLOR = { light: '#f7f7f4', dark: '#0f0f0e' } as const;

/**
 * Stamp the choice on <html>; the CSS tokens react to it (system = no stamp).
 * The theme-color metas in index.html are keyed to prefers-color-scheme, so an explicit
 * choice overrides both of them; "system" puts each back to its own scheme's colour.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const osDefault = (meta.getAttribute('media') ?? '').includes('dark') ? THEME_COLOR.dark : THEME_COLOR.light;
    meta.setAttribute('content', theme === 'system' ? osDefault : THEME_COLOR[theme]);
  });
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function nextTheme(theme: Theme): Theme {
  if (theme === 'system') return 'light';
  if (theme === 'light') return 'dark';
  return 'system';
}
