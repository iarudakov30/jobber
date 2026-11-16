import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/** A white panel with an optional heading, in the style of the other `ui` components. */
export function Card({
  title,
  action,
  className,
  children,
}: {
  title?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-6 shadow-sm',
        className,
      )}
    >
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          {title && <h2 className="text-lg font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
