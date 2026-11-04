import type { ReactNode } from 'react';

export function AuthCard({
  title,
  footer,
  children,
}: {
  title: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-6 text-xl font-semibold">{title}</h1>
      {children}
      <p className="mt-6 text-sm text-slate-600">{footer}</p>
    </section>
  );
}
