import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, readSession, setUnauthorizedHandler, writeSession, type Session } from '../api';
import { AuthContext } from './AuthContext';

interface Props {
  children: ReactNode;
  /** Test hook: start with a known session instead of reading localStorage. */
  initialSession?: Session | null;
}

export function AuthProvider({ children, initialSession }: Props) {
  const [session, setSession] = useState<Session | null>(() =>
    initialSession !== undefined ? initialSession : readSession(),
  );

  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (password: string) => {
    const res = await api.login(password);
    const next: Session = {
      token: res.token,
      role: res.role,
      user_id: res.user_id,
      display_name: res.display_name,
    };
    writeSession(next);
    setSession(next);
    return next;
  }, []);

  const logout = useCallback(() => {
    writeSession(null);
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, login, logout }), [session, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
