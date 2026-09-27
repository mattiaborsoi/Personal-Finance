import { api } from '../api';
import { useConfig } from '../config/ConfigContext';
import { setupSteps, type SetupStep } from '../lib/setup';
import { useAsync } from './useAsync';

/**
 * Where setup stands: the household document saved (GET /api/settings/household
 * `stored`), an active account (from the config, which the Accounts tab reloads),
 * an upload (GET /api/statements). Null while loading or when a request fails,
 * so the dashboard never waits on it.
 */
export function useSetupSteps(): SetupStep[] | null {
  const config = useConfig();
  const household = useAsync(() => api.getHousehold(), 'setup-household');
  const statements = useAsync(() => api.listStatements(), 'setup-statements');
  if (!household.data || !statements.data) return null;
  const activeAccounts = config.accounts.filter((a) => a.is_active !== false).length;
  return setupSteps(household.data.stored, activeAccounts, statements.data.length);
}
