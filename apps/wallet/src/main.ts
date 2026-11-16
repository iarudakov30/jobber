require('module-alias/register');
// Before anything that loads NestJS, http, gRPC or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('wallet');
import { NestFactory } from '@nestjs/core';
import { init } from '@jobber/nestjs';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  // GraphQL (path `wallet`) and the WalletService gRPC server come in the next steps.
  await init(app, 'wallet');
}

bootstrap();
