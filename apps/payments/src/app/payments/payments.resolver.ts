import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GqlAuthGuard } from '@jobber/graphql';
import { Idempotent } from '@jobber/idempotency';
import { User } from '@jobber/grpc';
import { CurrentUser } from './current-user.decorator';
import { CreateTopUpInput } from './dto/create-top-up.input';
import { Payment, TopUp } from './models/payment.models';
import { asGraphQL } from './payments.errors';
import { PaymentsService } from './payments.service';

@Resolver()
@UseGuards(GqlAuthGuard)
export class PaymentsResolver {
  constructor(private readonly service: PaymentsService) {}

  @Mutation(() => TopUp, {
    description:
      'Starts a top-up and returns the Stripe Checkout page to send the browser to. Requires ' +
      'an Idempotency-Key header: a retry with the same key and input returns the first result.',
  })
  @Idempotent({ operation: 'createTopUp' })
  createTopUp(
    @CurrentUser() user: User,
    @Args('input') input: CreateTopUpInput,
  ): Promise<TopUp> {
    return asGraphQL(() => this.service.createTopUp(user, input.amount));
  }

  @Query(() => Payment, {
    nullable: true,
    description:
      "One of the signed-in user's payments; null if there is none with that id.",
  })
  payment(
    @CurrentUser() user: User,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Payment | null> {
    return asGraphQL(() => this.service.payment(user.id, id));
  }

  @Query(() => [Payment], {
    description: "The signed-in user's payments, newest first.",
  })
  payments(
    @CurrentUser() user: User,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
  ): Promise<Payment[]> {
    return asGraphQL(() => this.service.list(user.id, first));
  }
}
