import {
  Link,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouter,
} from '@tanstack/react-router';

import { AppShell } from './components/app-shell';
import { AuthCard } from './features/auth/auth-card';
import { LoginForm } from './features/auth/login-form';
import { RegisterForm } from './features/auth/register-form';
import { HomePage } from './features/home/home-page';
import { session } from './lib/session';

interface LoginSearch {
  returnUrl?: string;
}

/** Only same-app paths: `//evil.com` or `https://…` would turn the login page into an open redirect. */
export function safeReturnUrl(returnUrl: string | undefined): string {
  return returnUrl?.startsWith('/') && !returnUrl.startsWith('//')
    ? returnUrl
    : '/';
}

const rootRoute = createRootRoute({ component: AppShell });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ location }) => {
    if (!session.get()) {
      throw redirect({ to: '/login', search: { returnUrl: location.href } });
    }
  },
  component: HomePage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    returnUrl:
      typeof search['returnUrl'] === 'string' ? search['returnUrl'] : undefined,
  }),
  beforeLoad: () => {
    if (session.get()) {
      throw redirect({ to: '/' });
    }
  },
  component: function LoginPage() {
    const { returnUrl } = loginRoute.useSearch();
    const router = useRouter();
    return (
      <AuthCard
        title="Sign in"
        footer={
          <>
            No account yet?{' '}
            <Link
              to="/register"
              className="font-medium text-slate-900 underline"
            >
              Create one
            </Link>
          </>
        }
      >
        <LoginForm
          onSuccess={() => router.history.push(safeReturnUrl(returnUrl))}
        />
      </AuthCard>
    );
  },
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  beforeLoad: () => {
    if (session.get()) {
      throw redirect({ to: '/' });
    }
  },
  component: function RegisterPage() {
    const router = useRouter();
    return (
      <AuthCard
        title="Create your account"
        footer={
          <>
            Already have an account?{' '}
            <Link
              to="/login"
              search={{}}
              className="font-medium text-slate-900 underline"
            >
              Sign in
            </Link>
          </>
        }
      >
        <RegisterForm onSuccess={() => router.navigate({ to: '/' })} />
      </AuthCard>
    );
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, loginRoute, registerRoute]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
