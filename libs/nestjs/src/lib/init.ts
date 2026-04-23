import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';

export async function init(app: INestApplication) {
  const globalPrefix = 'api';
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.setGlobalPrefix(globalPrefix);
  app.useLogger(app.get(Logger));
  app.use(cookieParser());

  const config = new DocumentBuilder()
    .setTitle('Jobber')
    .setDescription('The jobber API description')
    .setVersion('1.0')
    .addTag('jobber')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('swagger', app, documentFactory);

  const port: number = app.get(ConfigService).getOrThrow('PORT');
  await app.listen(port);

  app
    .get(Logger)
    .log(
      `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
    );
}
