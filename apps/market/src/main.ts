require('module-alias/register');
// Before anything that loads NestJS, http, gRPC or pg: instrumentation patches them on require.
require('@jobber/tracing').startTracing('market');
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { GrpcOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import { init } from '@jobber/nestjs';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // The simulator leader saves its open candles and releases its lock on SIGTERM.
  app.enableShutdownHooks();
  await init(app, 'market');
  // GenerateCandles, for the BackfillCandles job's consumer in the executor.
  app.connectMicroservice<GrpcOptions>({
    transport: Transport.GRPC,
    options: {
      url: app.get(ConfigService).getOrThrow('MARKET_GRPC_SERVICE_URL'),
      package: Packages.MARKET,
      protoPath: join(__dirname, '../../libs/grpc/proto/market.proto'),
      loader: GRPC_LOADER_OPTIONS,
    },
  });
  await app.startAllMicroservices();
}

bootstrap();
