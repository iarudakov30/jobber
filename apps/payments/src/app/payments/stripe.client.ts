import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';

/**
 * Pinned, so a version change in the Stripe dashboard can't change payload shapes under us. It is
 * the version `stripe` 23.1.0 was built for; upgrade both together.
 */
export const STRIPE_API_VERSION = '2026-10-28.endive' as const;

export const stripeClientProvider = {
  provide: STRIPE_CLIENT,
  useFactory: (configService: ConfigService) =>
    new Stripe(configService.getOrThrow<string>('STRIPE_SECRET_KEY'), {
      apiVersion: STRIPE_API_VERSION,
      // Retries network errors and 409/5xx; safe because every call that creates something
      // passes an idempotency key (the SDK adds one to retried POSTs too).
      maxNetworkRetries: 2,
      timeout: 20_000,
    }),
  inject: [ConfigService],
};
