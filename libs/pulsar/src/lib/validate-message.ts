import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';

import { NonRetryableError } from './pulsar.consumer';

/**
 * Checks a consumed payload against its message class. Invalid data never becomes valid on a
 * retry, so it throws `NonRetryableError` (the message is dead-lettered at once, by
 * `PulsarConsumer` and by `RabbitConsumer`, which matches the error by name).
 */
export async function validateMessage<T extends object>(
  messageClass: new () => T,
  data: unknown,
): Promise<T> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new NonRetryableError(
      `Invalid ${messageClass.name}: expected an object`,
    );
  }
  const message = plainToInstance(messageClass, data);
  const errors = await validate(message, { forbidUnknownValues: true });
  if (errors.length) {
    throw new NonRetryableError(
      `Invalid ${messageClass.name}: ${constraintTexts(errors).join('; ')}`,
    );
  }
  return message;
}

/** class-validator messages already start with the property name ("amount must be ..."). */
function constraintTexts(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}),
    ...constraintTexts(e.children ?? []),
  ]);
}
