import { Module } from '@nestjs/common';
import { JobsModule } from './jobs/jobs.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    JobsModule,
    ConfigModule.forRoot({ isGlobal: true, envFilePath: 'apps/executor/.env' }),
  ],
})
export class AppModule {}
