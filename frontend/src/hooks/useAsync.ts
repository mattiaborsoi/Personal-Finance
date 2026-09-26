import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';

export interface AsyncResult<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
  /** Update the loaded data in place (optimistic updates). */
  setData: (updater: (previous: T | null) => T | null) => void;
}

interface Slot<T> {
  key: string | null;
  data: T | null;
  error: ApiError | Error | null;
}

function asError(err: unknown): ApiError | Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

/**
 * Loads data whenever `key` changes. Data for the same key is kept while a
 * reload is in flight; a new key starts from a blank slate.
 */
export function useAsync<T>(loader: () => Promise<T>, key: string, enabled = true): AsyncResult<T> {
  const [tick, setTick] = useState(0);
  const fullKey = `${key}#${tick}`;
  const [slot, setSlot] = useState<Slot<T>>({ key: null, data: null, error: null });

  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loaderRef
      .current()
      .then((data) => {
        if (!cancelled) setSlot({ key: fullKey, data, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setSlot((previous) => ({ key: fullKey, data: previous.data, error: asError(err) }));
      });
    return () => {
      cancelled = true;
    };
  }, [fullKey, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback(
    (updater: (previous: T | null) => T | null) =>
      setSlot((previous) => ({ ...previous, data: updater(previous.data), error: null })),
    [],
  );

  const isCurrent = slot.key === fullKey;
  const sameKey = slot.key !== null && slot.key.startsWith(`${key}#`);

  return {
    data: sameKey ? slot.data : null,
    error: isCurrent ? slot.error : null,
    loading: enabled && !isCurrent,
    reload,
    setData,
  };
}
