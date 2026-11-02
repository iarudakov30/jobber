require('module-alias/register');
// Before anything that loads NestJS, http, gRPC or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('auth');
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GrpcOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

import { join } from 'path';

import { Packages } from '@jobber/grpc';
import { init } from '@jobber/nestjs';

import { AppModule } from './app/app.module';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  await init(app, 'auth');
  app.connectMicroservice<GrpcOptions>({
    transport: Transport.GRPC,
    options: {
      url: app.get(ConfigService).getOrThrow('AUTH_GRPC_SERVICE_URL'),
      package: Packages.AUTH,
      protoPath: join(__dirname, '../../libs/grpc/proto/auth.proto'),
    },
  });
  await app.startAllMicroservices();
}

bootstrap();
