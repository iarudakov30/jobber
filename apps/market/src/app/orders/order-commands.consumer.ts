import { Injectable } from '@nestjs/common';
import {
  NonRetryableError,
  RabbitConnection,
  RabbitConsumer,
  RabbitMessageMeta,
} from '@jobber/rabbitmq';
import { MARKET_COMMANDS_QUEUE, ORDER_EXPIRE } from '../topology';
import { OrdersService, isUuid } from './orders.service';

export interface ExpireOrderCommand {
  orderId: string;
}

/**
 * Commands for the market from `market.commands` (bound to `commands` with `order.*`). Today
 * only `order.expire`, which arrives through a delay bucket 24 h after a limit order was
 * placed. A thrown error retries after 5 s, 30 s and 5 min, then dead-letters to
 * `market.commands.dlq`. Any replica may take it: expiring is a conditional update.
 */
@Injectable()
export class OrderCommandsConsumer extends RabbitConsumer<ExpireOrderCommand> {
  constructor(
    connection: RabbitConnection,
    private readonly orders: OrdersService,
  ) {
    super(connection, MARKET_COMMANDS_QUEUE);
  }

  protected async onMessage(
    data: ExpireOrderCommand,
    meta: RabbitMessageMeta,
  ): Promise<void> {
    if (meta.routingKey !== ORDER_EXPIRE) {
      throw new NonRetryableError(`Unknown command ${meta.routingKey}`);
    }
    if (typeof data?.orderId !== 'string' || !isUuid(data.orderId)) {
      throw new NonRetryableError('order.expire needs an orderId');
    }
    const outcome = await this.orders.expire(data.orderId);
    this.logger.log(`order.expire ${data.orderId}: ${outcome}`);
  }
}
