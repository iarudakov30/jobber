require('module-alias/register');
// Before anything that loads NestJS, http, gRPC or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('jobs');
import { GrpcOptions, Transport } from '@nestjs/microservices';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { init } from '@jobber/nestjs';
import { ConfigService } from '@nestjs/config';
import { Packages } from '@jobber/grpc';
import { join } from 'path';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  await init(app, 'jobs');
  app.connectMicroservice<GrpcOptions>({
    transport: Transport.GRPC,
    options: {
      url: app.get(ConfigService).getOrThrow('JOBS_GRPC_SERVICE_URL'),
      package: Packages.JOBS,
      protoPath: join(__dirname, '../../libs/grpc/proto/jobs.proto'),
    },
  });
  await app.startAllMicroservices();
}

bootstrap();
