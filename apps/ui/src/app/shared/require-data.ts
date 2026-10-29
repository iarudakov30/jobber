import { OperatorFunction, map } from 'rxjs';

/**
 * Unwraps `data` from a mutation result. With the default `errorPolicy: 'none'` Apollo errors
 * the observable instead of emitting, so a missing payload here is an unexpected server response.
 */
export function requireData<T>(): OperatorFunction<{ data?: T | null }, T> {
  return map(({ data }) => {
    if (data == null) {
      throw new Error('The server returned an empty response.');
    }
    return data;
  });
}
