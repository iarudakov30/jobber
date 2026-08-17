require('module-alias/register');
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GrpcOptions, Transport } from '@nestjs/microservices';

import { join } from 'path';

import { Packages } from '@jobber/grpc';
import { init } from '@jobber/nestjs';

import { AppModule } from './app/app.module';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  await init(app);
  app.connectMicroservice<GrpcOptions>({
    transport: Transport.GRPC,
    options: {
      package: Packages.AUTH,
      protoPath: join(__dirname, '../../libs/grpc/proto/auth.proto'),
    },
  });
  await app.startAllMicroservices();
}

bootstrap();
