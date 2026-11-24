import { Link } from '@tanstack/react-router';

import { Card } from '../../components/ui/card';
import { LoginForm } from './login-form';

/** The sign-in page. Where to go after signing in is the route's business (`returnUrl`). */
export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  return (
    <Card title="Sign in" className="mx-auto max-w-sm">
      <LoginForm onSuccess={onSuccess} />
      <p className="mt-6 text-sm text-slate-600">
        No account yet?{' '}
        <Link to="/register" className="font-medium text-slate-900 underline">
          Create one
        </Link>
      </p>
    </Card>
  );
}
