import { ClientError } from 'graphql-request';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

/**
 * Turns a failed GraphQL request into readable messages.
 *
 * NestJS reports `HttpException`s (including `ValidationPipe` failures) as a generic message
 * such as "Bad Request Exception", with the real detail under `extensions.originalError.message`
 * (a string or an array of class-validator messages).
 */
export function errorMessages(error: unknown): string[] {
  if (error instanceof ClientError) {
    const errors = error.response.errors ?? [];
    if (errors.length === 0) {
      return [`Request failed (HTTP ${error.response.status}).`];
    }
    return errors.flatMap((e) => {
      const original = (
        e.extensions?.['originalError'] as
          { message?: string | string[] } | undefined
      )?.message;
      return original ?? e.message;
    });
  }
  if (error instanceof TypeError) {
    // `fetch` rejects with a TypeError when the server can't be reached at all.
    return ['Cannot reach the server. Is it running?'];
  }
  if (error instanceof Error) {
    return [error.message];
  }
  return ['Something went wrong.'];
}

/**
 * Puts server errors onto a React Hook Form form.
 *
 * class-validator messages start with the property name ("password is not strong enough"), so
 * those go on the matching field in `fields`; everything else becomes the form-level
 * `root.server` error.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[] = [],
): void {
  const formMessages: string[] = [];
  for (const message of errorMessages(error)) {
    const field = fields.find((name) => message.split(' ')[0] === name);
    if (field) {
      setError(field, { type: 'server', message });
    } else {
      formMessages.push(message);
    }
  }
  if (formMessages.length) {
    setError('root.server', {
      type: 'server',
      message: formMessages.join('\n'),
    });
  }
}
