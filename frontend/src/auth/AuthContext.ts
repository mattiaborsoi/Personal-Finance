import { createContext, useContext } from 'react';
import type { Session } from '../api';

export interface AuthContextValue {
  session: Session | null;
  login: (password: string) => Promise<Session>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
