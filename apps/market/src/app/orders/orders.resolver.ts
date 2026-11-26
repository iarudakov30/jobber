import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GqlAuthGuard } from '@jobber/graphql';
import { User } from '@jobber/grpc';
import { Idempotent, IdempotencyKey } from '@jobber/idempotency';
import { CurrentUser } from '../market/current-user.decorator';
import { asGraphQL } from '../market/market.errors';
import {
  Order,
  OrderStatusEnum,
  PlaceOrderInput,
  toOrder,
} from './models/order.models';
import { OrdersService } from './orders.service';
import { OrderStatus } from './schema';

@Resolver()
@UseGuards(GqlAuthGuard)
export class OrdersResolver {
  constructor(private readonly service: OrdersService) {}

  @Mutation(() => Order, {
    description:
      'Places a market order (from a quote) or a limit order (funds held until it fills, is cancelled or expires after 24 h). ' +
      'Requires an Idempotency-Key header: a retry with the same key and input returns the first result. ' +
      'Lack of funds gives a REJECTED order; a used or expired quote gives QUOTE_EXPIRED.',
  })
  @Idempotent({ operation: 'placeOrder' })
  placeOrder(
    @CurrentUser() user: User,
    @Args('input') input: PlaceOrderInput,
    @IdempotencyKey() key?: string,
  ): Promise<Order> {
    return asGraphQL(async () =>
      toOrder(await this.service.place(user.id, input, key)),
    );
  }

  @Mutation(() => Order, {
    description:
      'Cancels an open limit order and releases its funds. Cancelling it again returns it; any other status gives ORDER_NOT_OPEN.',
  })
  cancelOrder(
    @CurrentUser() user: User,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Order> {
    return asGraphQL(async () =>
      toOrder(await this.service.cancel(user.id, id)),
    );
  }

  @Query(() => [Order], {
    description:
      "The signed-in user's orders, newest first; only those in status if given.",
  })
  orders(
    @CurrentUser() user: User,
    @Args('status', { type: () => [OrderStatusEnum], nullable: true })
    status: OrderStatus[] | null,
    @Args('first', { type: () => Int, defaultValue: 50 }) first: number,
  ): Promise<Order[]> {
    return asGraphQL(async () =>
      (await this.service.list(user.id, status, first)).map(toOrder),
    );
  }
}
