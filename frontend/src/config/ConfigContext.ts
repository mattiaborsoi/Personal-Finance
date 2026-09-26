import { createContext, useContext } from 'react';
import type { AppConfig } from '../api';

export const ConfigContext = createContext<AppConfig | null>(null);

/**
 * Re-fetches GET /api/config and swaps it in without unmounting the app, for
 * pages that change what the config describes (the Accounts tab). Outside
 * <ConfigProvider>, e.g. under a static config in tests, it is a no-op.
 */
export const ReloadConfigContext = createContext<() => Promise<void>>(() => Promise.resolve());

/** The sanitised app config; only rendered once loaded, so never null here. */
export function useConfig(): AppConfig {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used inside <ConfigProvider>');
  return ctx;
}

/** A function that reloads the config; it rejects when the request fails, leaving the current config in place. */
export function useReloadConfig(): () => Promise<void> {
  return useContext(ReloadConfigContext);
}

/** Display names for the two household members. */
export function useNames(): { primary: string; secondary: string } {
  const config = useConfig();
  return { primary: config.users.primary.display_name, secondary: config.users.secondary.display_name };
}

export function useCurrency(): string {
  return useConfig().currency_symbol;
}
