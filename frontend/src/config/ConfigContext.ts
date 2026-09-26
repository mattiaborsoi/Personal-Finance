import { createContext, useContext } from 'react';
import type { AppConfig } from '../api';

export const ConfigContext = createContext<AppConfig | null>(null);

/** The sanitised app config; only rendered once loaded, so never null here. */
export function useConfig(): AppConfig {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used inside <ConfigProvider>');
  return ctx;
}

/** Display names for the two household members. */
export function useNames(): { primary: string; secondary: string } {
  const config = useConfig();
  return { primary: config.users.primary.display_name, secondary: config.users.secondary.display_name };
}

export function useCurrency(): string {
  return useConfig().currency_symbol;
}
