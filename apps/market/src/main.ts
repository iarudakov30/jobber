require('module-alias/register');
// Before anything that loads NestJS, http, gRPC or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('market');
import { NestFactory } from '@nestjs/core';
import { init } from '@jobber/nestjs';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // The simulator leader saves its open candles and releases its lock on SIGTERM.
  app.enableShutdownHooks();
  await init(app, 'market');
}

bootstrap();
