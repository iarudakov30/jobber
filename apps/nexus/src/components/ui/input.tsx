import type { InputHTMLAttributes, Ref } from 'react';

import { cn } from '../../lib/cn';

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-xs',
        'placeholder:text-slate-400 focus-visible:border-slate-900 focus-visible:outline-none',
        'aria-invalid:border-red-500',
        className,
      )}
      {...props}
    />
  );
}
