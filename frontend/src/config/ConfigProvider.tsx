import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, type AppConfig } from '../api';
import { ConfigContext, ReloadConfigContext } from './ConfigContext';
import { LoadingState } from '../components/LoadingState';
import { ErrorMessage } from '../components/ErrorMessage';
import { btnSecondary } from '../lib/ui';

interface Props {
  children: ReactNode;
}

interface State {
  config: AppConfig | null;
  error: string | null;
}

/**
 * Loads GET /api/config once after login and blocks rendering until it is
 * available. `useReloadConfig()` re-fetches it quietly later on: the current
 * config stays in place until the new one arrives.
 */
export function ConfigProvider({ children }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ config: null, error: null });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((config) => {
        if (!cancelled) setState({ config, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ config: null, error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(async () => {
    const config = await api.getConfig();
    if (mounted.current) setState({ config, error: null });
  }, []);

  if (state.error) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorMessage message={`Could not load configuration: ${state.error}`} />
        <button
          type="button"
          className={`${btnSecondary} mt-4`}
          onClick={() => {
            setState({ config: null, error: null });
            setAttempt((a) => a + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!state.config) {
    return <LoadingState label="Loading configuration" fullPage />;
  }

  return (
    <ReloadConfigContext.Provider value={reload}>
      <ConfigContext.Provider value={state.config}>{children}</ConfigContext.Provider>
    </ReloadConfigContext.Provider>
  );
}
