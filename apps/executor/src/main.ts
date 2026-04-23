require('module-alias/register');
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './app/app.module';
import { init } from '@jobber/nestjs';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  await init(app);
}

bootstrap();
