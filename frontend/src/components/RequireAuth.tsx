import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '../api';
import { useAuth } from '../auth/AuthContext';

interface Props {
  roles?: Role[];
}

/** Redirects to /login when signed out; sends the wrong role to its home route. */
export function RequireAuth({ roles }: Props) {
  const { session } = useAuth();
  const location = useLocation();

  if (!session) {
    // Keep the query string (period filters etc.) so login lands on the same view.
    const from = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  if (roles && !roles.includes(session.role)) {
    return <Navigate to={session.role === 'secondary' ? '/claim' : '/'} replace />;
  }
  return <Outlet />;
}
