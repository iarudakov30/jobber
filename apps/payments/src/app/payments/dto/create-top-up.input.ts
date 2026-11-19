import { Field, InputType } from '@nestjs/graphql';
import { ValidateBy } from 'class-validator';
import { MinorUnits } from '../models/minor-units.scalar';

/**
 * Also keeps the field: the global `ValidationPipe({ whitelist: true })` strips any property
 * without a class-validator decorator. The range and the daily limit are the service's job.
 */
function IsBigInt(): PropertyDecorator {
  return ValidateBy({
    name: 'isBigInt',
    validator: {
      validate: (value: unknown) => typeof value === 'bigint',
      defaultMessage: (args) => `${args?.property} must be an amount`,
    },
  });
}

@InputType()
export class CreateTopUpInput {
  @Field(() => MinorUnits, {
    description: 'USD minor units, "100" to "100000" ($1.00 to $1,000.00).',
  })
  @IsBigInt()
  amount: bigint;
}
