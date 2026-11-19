import { Module } from '@nestjs/common';
import { ConditionalModule, ConfigModule } from '@nestjs/config';
import { LoggerModule } from '@jobber/nestjs';
import { JobsModule } from './jobs/jobs.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    LoggerModule,
    JobsModule,
    ConfigModule.forRoot({ isGlobal: true, envFilePath: 'apps/executor/.env' }),
    // The email worker, only where RabbitMQ is configured.
    ConditionalModule.registerWhen(NotificationsModule, 'RABBITMQ_URL'),
  ],
})
export class AppModule {}
