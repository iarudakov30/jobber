require('module-alias/register');
// Before anything that loads NestJS, http or gRPC: instrumentation patches them on require.
require('@jobber/tracing').startTracing('realtime');
import { NestFactory } from '@nestjs/core';
import { init } from '@jobber/nestjs';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // SIGTERM closes every socket with 1012, so clients reconnect to another replica at once.
  app.enableShutdownHooks();
  await init(app, 'realtime');
}

bootstrap();
