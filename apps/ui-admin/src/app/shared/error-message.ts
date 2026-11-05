import { CombinedGraphQLErrors } from '@apollo/client';
import { ReadonlyFieldTree, ValidationError } from '@angular/forms/signals';

/**
 * Turns an Apollo error into readable messages.
 *
 * NestJS reports `HttpException`s (including `ValidationPipe` failures) as a generic message
 * such as "Bad Request Exception", with the real detail under `extensions.originalError.message`
 * (a string or an array of validation messages).
 */
export function errorMessages(error: unknown): string[] {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.flatMap((e) => {
      const original = (
        e.extensions?.['originalError'] as
          { message?: string | string[] } | undefined
      )?.message;
      return original ?? e.message;
    });
  }
  if (error instanceof Error) {
    return [error.message];
  }
  return ['Something went wrong.'];
}

export function errorMessage(error: unknown): string {
  return errorMessages(error).join('\n');
}

/**
 * Converts a failed request into signal-form submission errors.
 *
 * class-validator messages start with the property name ("password is not strong enough"), so
 * those are attached to the matching field in `fields`; anything else lands on the form itself.
 */
export function serverErrors(
  error: unknown,
  fields: Record<string, ReadonlyFieldTree<unknown>> = {},
): ValidationError.WithOptionalFieldTree[] {
  return errorMessages(error).map((message) => ({
    kind: 'server',
    message,
    fieldTree: fields[message.split(' ')[0]],
  }));
}
