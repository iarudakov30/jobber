import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from '@jobber/nestjs';
import { RabbitModule, realtimeTopology } from '@jobber/rabbitmq';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule.forRoot({ isGlobal: true }),
    RabbitModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.getOrThrow('RABBITMQ_URL'),
        topology: realtimeTopology(),
        connectionName: 'realtime',
      }),
    }),
    GatewayModule,
  ],
})
export class AppModule {}
