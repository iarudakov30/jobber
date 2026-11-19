import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import Stripe from 'stripe';
import { PaymentsService } from './payments.service';
import { STRIPE_CLIENT } from './stripe.client';

/**
 * `POST /payments/webhooks/stripe`. The signature is checked against the exact bytes Stripe
 * sent (`rawBody: true` in `main.ts`): re-serialised JSON would not match. A bad signature is a
 * 400 and writes nothing; an error while applying is a 500, and Stripe retries the delivery.
 */
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  private readonly secret: string | undefined;

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly payments: PaymentsService,
    configService: ConfigService,
  ) {
    this.secret =
      configService.get<string>('STRIPE_WEBHOOK_SECRET') || undefined;
    if (!this.secret) {
      this.logger.warn(
        'STRIPE_WEBHOOK_SECRET is not set: webhooks are refused until it is. Run `stripe listen ' +
          '--forward-to localhost:3005/payments/webhooks/stripe` and put its whsec_ secret in ' +
          'apps/payments/.env.local.',
      );
    }
  }

  @Post('stripe')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true; duplicate: boolean }> {
    if (!this.secret) {
      throw new ServiceUnavailableException('Webhook secret not configured');
    }
    let event: Stripe.Event;
    try {
      if (!req.rawBody || !signature) {
        throw new Error('missing body or Stripe-Signature header');
      }
      event = this.stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        this.secret,
      );
    } catch (error) {
      this.logger.warn(`Rejected a webhook: ${(error as Error).message}`);
      throw new BadRequestException('Invalid Stripe signature');
    }
    const outcome = await this.payments.applyStripeEvent(event);
    this.logger.log(`Stripe ${event.type} ${event.id}: ${outcome}`);
    return { received: true, duplicate: outcome === 'duplicate' };
  }
}
