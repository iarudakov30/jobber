require('module-alias/register');
// Before anything that loads NestJS, http, gRPC or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('executor');
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './app/app.module';
import { init } from '@jobber/nestjs';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  await init(app);
}

bootstrap();
