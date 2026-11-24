import { Link } from '@tanstack/react-router';

import { Card } from '../../components/ui/card';
import { RegisterForm } from './register-form';

/** The sign-up page. The route decides where a new user lands. */
export function RegisterPage({ onSuccess }: { onSuccess: () => void }) {
  return (
    <Card title="Create your account" className="mx-auto max-w-sm">
      <RegisterForm onSuccess={onSuccess} />
      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{' '}
        <Link
          to="/login"
          search={{}}
          className="font-medium text-slate-900 underline"
        >
          Sign in
        </Link>
      </p>
    </Card>
  );
}
