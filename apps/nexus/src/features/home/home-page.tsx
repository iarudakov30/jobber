import { useSession } from '../../lib/session';

export function HomePage() {
  const user = useSession();

  return (
    <section className="space-y-2">
      <h1 className="text-2xl font-semibold">
        Welcome{user ? `, ${user.email}` : ''}
      </h1>
      <p className="text-slate-600">
        Your wallet, markets and trading screens arrive in the next phases.
      </p>
    </section>
  );
}
