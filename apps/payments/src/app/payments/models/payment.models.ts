import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { PAYMENT_STATUSES, PaymentStatus } from '../schema';
import { MinorUnits } from './minor-units.scalar';

const PaymentStatusEnum = Object.fromEntries(
  PAYMENT_STATUSES.map((s) => [s, s]),
) as { [S in PaymentStatus]: S };

registerEnumType(PaymentStatusEnum, {
  name: 'PaymentStatus',
  description:
    'PENDING until Stripe reports the outcome; then SUCCEEDED (credited), EXPIRED (not paid ' +
    'in time) or FAILED (Checkout could not be started).',
});

@ObjectType({ description: 'A top-up of the wallet through Stripe Checkout.' })
export class Payment {
  @Field(() => ID)
  id: string;

  @Field(() => MinorUnits)
  amount: bigint;

  @Field()
  currency: string;

  @Field(() => PaymentStatusEnum)
  status: PaymentStatus;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class TopUp {
  @Field(() => ID)
  paymentId: string;

  @Field({
    description: "Stripe's hosted Checkout page; send the browser there.",
  })
  checkoutUrl: string;
}
