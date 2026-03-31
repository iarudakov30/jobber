import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { init } from '@jobber/nestjs';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule);
  await init(app);
}

bootstrap();
