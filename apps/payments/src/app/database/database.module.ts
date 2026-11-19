import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DATABASE_CONNECTION, DATABASE_POOL, schema } from './database';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (configService: ConfigService) =>
        new Pool({
          connectionString: configService.getOrThrow('DATABASE_URL'),
        }),
      inject: [ConfigService],
    },
    {
      provide: DATABASE_CONNECTION,
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
      inject: [DATABASE_POOL],
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
