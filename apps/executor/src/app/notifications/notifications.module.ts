import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { createTransport } from 'nodemailer';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import { RabbitModule, notificationsTopology } from '@jobber/rabbitmq';
import { EmailConsumer, MAILER } from './email.consumer';
import { RedisSentEmails, SENT_EMAILS, SentEmails } from './sent-emails';

/**
 * The email worker. `AppModule` loads it only when `RABBITMQ_URL` is set, so deployments of the
 * executor without RabbitMQ (docker-compose.apps.yaml, the Helm chart) start as before.
 */
@Module({
  imports: [
    RabbitModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.getOrThrow('RABBITMQ_URL'),
        topology: notificationsTopology(),
        connectionName: 'executor',
      }),
    }),
    ClientsModule.registerAsync([
      {
        // GetUser: the recipient's address.
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
  providers: [
    EmailConsumer,
    {
      provide: MAILER,
      useFactory: (configService: ConfigService) =>
        createTransport(configService.getOrThrow<string>('SMTP_URL')),
      inject: [ConfigService],
    },
    {
      provide: SENT_EMAILS,
      useFactory: (configService: ConfigService) =>
        RedisSentEmails.connect(configService.getOrThrow('REDIS_URL')),
      inject: [ConfigService],
    },
  ],
})
export class NotificationsModule implements OnApplicationShutdown {
  constructor(@Inject(SENT_EMAILS) private readonly sent: SentEmails) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sent.close?.();
  }
}
