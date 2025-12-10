import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  datasource: {
    url: env('AUTH_DATABASE_URL'),
  },
  schema: 'prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
});
