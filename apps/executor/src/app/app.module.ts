import { Module } from '@nestjs/common';
import { JobsModule } from './jobs/jobs.module';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from '@jobber/nestjs';

@Module({
  imports: [
    LoggerModule,
    JobsModule,
    ConfigModule.forRoot({ isGlobal: true, envFilePath: 'apps/executor/.env' }),
  ],
})
export class AppModule {}
