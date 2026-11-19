import { Injectable } from '@nestjs/common';
import {
  NonRetryableError,
  RabbitConnection,
  RabbitConsumer,
  RabbitMessageMeta,
} from '@jobber/rabbitmq';
import { PaymentsService } from './payments.service';
import { PAYMENT_EXPIRE, PAYMENTS_COMMANDS_QUEUE } from './topology';

export interface ExpirePaymentCommand {
  paymentId: string;
}

/**
 * Commands for `payments` from the `payments.commands` queue (bound to `commands` with
 * `payment.*`). Today only `payment.expire`, which arrives through a delay bucket. A thrown error
 * retries after 5 s, 30 s and 5 min, then dead-letters to `payments.commands.dlq`.
 */
@Injectable()
export class PaymentCommandsConsumer extends RabbitConsumer<ExpirePaymentCommand> {
  constructor(
    connection: RabbitConnection,
    private readonly payments: PaymentsService,
  ) {
    super(connection, PAYMENTS_COMMANDS_QUEUE);
  }

  protected async onMessage(
    data: ExpirePaymentCommand,
    meta: RabbitMessageMeta,
  ): Promise<void> {
    if (meta.routingKey !== PAYMENT_EXPIRE) {
      throw new NonRetryableError(`Unknown command ${meta.routingKey}`);
    }
    if (typeof data?.paymentId !== 'string') {
      throw new NonRetryableError('payment.expire needs a paymentId');
    }
    const outcome = await this.payments.expire(data.paymentId);
    this.logger.log(`payment.expire ${data.paymentId}: ${outcome}`);
  }
}
