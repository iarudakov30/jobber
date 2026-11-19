require('module-alias/register');
// Before anything that loads NestJS, http or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('payments');
import { NestFactory } from '@nestjs/core';
import { init } from '@jobber/nestjs';
import { AppModule } from './app/app.module';

async function bootstrap() {
  // rawBody: the Stripe webhook signature covers the exact bytes Stripe sent.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.enableShutdownHooks();
  await init(app, 'payments');
}

bootstrap();
