/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

require('module-alias/register');
// Before anything that loads NestJS, http, gRPC or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('products');
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';
import { init } from '@jobber/nestjs';
import { GrpcOptions, Transport } from '@nestjs/microservices';
import { Packages } from '@jobber/grpc';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  await init(app);
  app.connectMicroservice<GrpcOptions>({
    transport: Transport.GRPC,
    options: {
      url: app.get(ConfigService).getOrThrow('PRODUCTS_GRPC_SERVICE_URL'),
      package: Packages.PRODUCTS,
      protoPath: join(__dirname, '../../libs/grpc/proto/products.proto'),
    },
  });
  await app.startAllMicroservices();
}

bootstrap();
