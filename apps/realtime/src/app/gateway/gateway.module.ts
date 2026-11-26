import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import {
  DEFAULT_GATEWAY_OPTIONS,
  GATEWAY_OPTIONS,
  GatewayOptions,
  RealtimeGateway,
} from './realtime.gateway';
import { RealtimeFeed } from './realtime-feed';
import { SocketAuth } from './socket-auth';
import { StatsController } from './stats.controller';

/** The WebSocket gateway. Needs the global `RabbitModule` (with the realtime topology). */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: Packages.AUTH,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            url: configService.getOrThrow('AUTH_GRPC_SERVICE_URL'),
            package: Packages.AUTH,
            protoPath: join(__dirname, '../../libs/grpc/proto/auth.proto'),
            loader: GRPC_LOADER_OPTIONS,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [StatsController],
  providers: [
    SocketAuth,
    RealtimeFeed,
    RealtimeGateway,
    {
      provide: GATEWAY_OPTIONS,
      useFactory: (config: ConfigService): GatewayOptions => ({
        ...DEFAULT_GATEWAY_OPTIONS,
        allowedOrigins: config
          .get<string>('REALTIME_ALLOWED_ORIGINS', '')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      }),
      inject: [ConfigService],
    },
  ],
  exports: [RealtimeGateway],
})
export class GatewayModule {}
