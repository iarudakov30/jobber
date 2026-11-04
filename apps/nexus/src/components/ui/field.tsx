import type { ReactNode } from 'react';

/** A labelled form control with its validation message underneath. */
export function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/** Form-level errors that don't belong to a single field. */
export function FormError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }
  return (
    <p
      role="alert"
      className="whitespace-pre-line rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {message}
    </p>
  );
}
