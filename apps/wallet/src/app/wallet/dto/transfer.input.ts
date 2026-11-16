import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsIn, ValidateBy } from 'class-validator';
import { ASSETS } from '@jobber/money';
import { MinorUnits } from '../models/minor-units.scalar';

/** class-validator's `@IsPositive()` only accepts JS numbers. */
function IsPositiveBigInt(): PropertyDecorator {
  return ValidateBy({
    name: 'isPositiveBigInt',
    validator: {
      validate: (value: unknown) => typeof value === 'bigint' && value > 0n,
      defaultMessage: (args) => `${args?.property} must be positive`,
    },
  });
}

@InputType()
export class TransferInput {
  @Field()
  @IsEmail()
  toEmail: string;

  @Field()
  @IsIn(Object.keys(ASSETS))
  asset: string;

  @Field(() => MinorUnits)
  @IsPositiveBigInt()
  amount: bigint;
}
