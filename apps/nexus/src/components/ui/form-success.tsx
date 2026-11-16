/** A confirmation under a form, announced to screen readers. */
export function FormSuccess({ message }: { message?: string }) {
  if (!message) {
    return null;
  }
  return (
    <p
      role="status"
      className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
    >
      {message}
    </p>
  );
}
