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
import { TopUpPage } from './features/topup/topup-page';
import { SendPage } from './features/wallet/send-page';
import { WalletPage } from './features/wallet/wallet-page';
import { session } from './lib/session';

interface LoginSearch {
  returnUrl?: string;
}

interface WalletSearch {
  /** Set by Stripe's success_url: the payment to follow until it's credited. */
  topup?: string;
}

/** Only same-app paths: `//evil.com` or `https://…` would turn the login page into an open redirect. */
export function safeReturnUrl(returnUrl: string | undefined): string {
  return returnUrl?.startsWith('/') && !returnUrl.startsWith('//')
    ? returnUrl
    : '/';
}

const rootRoute = createRootRoute({ component: AppShell });

/** Pages that need a signed-in user send everyone else to the login page, and back after. */
function requireSession({ location }: { location: { href: string } }) {
  if (!session.get()) {
    throw redirect({ to: '/login', search: { returnUrl: location.href } });
  }
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/wallet' });
  },
});

const walletRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/wallet',
  validateSearch: (search: Record<string, unknown>): WalletSearch => ({
    topup: typeof search['topup'] === 'string' ? search['topup'] : undefined,
  }),
  beforeLoad: requireSession,
  component: function WalletRoute() {
    const { topup } = walletRoute.useSearch();
    const navigate = walletRoute.useNavigate();
    return (
      <WalletPage
        topUpId={topup}
        onDismissTopUp={() => navigate({ search: {}, replace: true })}
      />
    );
  },
});

const topUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/topup',
  beforeLoad: requireSession,
  component: () => <TopUpPage />,
});

const sendRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/send',
  beforeLoad: requireSession,
  component: SendPage,
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
        <RegisterForm onSuccess={() => router.navigate({ to: '/wallet' })} />
      </AuthCard>
    );
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    homeRoute,
    walletRoute,
    topUpRoute,
    sendRoute,
    loginRoute,
    registerRoute,
  ]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
