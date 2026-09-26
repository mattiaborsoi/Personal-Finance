import { Compass, House } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { btnPrimary } from '../lib/ui';

export function NotFoundPage() {
  const { session } = useAuth();
  const home = session?.role === 'secondary' ? '/claim' : '/';
  return (
    <div className="mx-auto max-w-md py-10">
      <Card>
        <EmptyState
          icon={Compass}
          title="Page not found"
          hint="That page does not exist."
          action={
            <Link to={home} className={btnPrimary}>
              <House className="h-4 w-4" aria-hidden="true" />
              Go home
            </Link>
          }
        />
      </Card>
    </div>
  );
}
