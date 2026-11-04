import { Link, Outlet, useRouter } from '@tanstack/react-router';

import { session, useSession } from '../lib/session';
import { Button } from './ui/button';

export function AppShell() {
  const user = useSession();
  const router = useRouter();

  // `auth` has no logout mutation, so signing out only forgets the user here; the cookie
  // stays until it expires, and the next guarded request would still be authenticated.
  const signOut = async () => {
    session.clear();
    await router.navigate({ to: '/login', search: {} });
  };

  return (
    <div className="min-h-screen">
      <p className="bg-amber-100 py-1 text-center text-xs font-medium text-amber-900">
        Simulated market · no real money
      </p>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            NexusPay
          </Link>
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-600">{user.email}</span>
              <Button variant="ghost" onClick={signOut}>
                Sign out
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10">
        <Outlet />
      </main>
    </div>
  );
}
