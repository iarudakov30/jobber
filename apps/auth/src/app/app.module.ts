import { Module } from '@nestjs/common';
import { join } from 'path';
import { GraphQLModule } from '@nestjs/graphql';
import { ConfigModule } from '@nestjs/config';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';

import { LoggerModule } from '@jobber/nestjs';
import { GqlLoggingPlugin } from '@jobber/graphql';

import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule.forRoot({ isGlobal: true, envFilePath: 'apps/auth/.env' }),
    PrismaModule,
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      plugins: [new GqlLoggingPlugin()],
      graphiql: true,
      path: 'auth',
      playground: false,
      context: ({ req, res }) => ({ req, res }),
      // Printed on startup (Nx runs the app from the workspace root) and committed: the React app's
      // GraphQL Codegen reads it. src/app/schema.spec.ts fails when it's stale.
      autoSchemaFile: join(process.cwd(), 'apps/auth/schema.gql'),
      sortSchema: true,
    }),
    UsersModule,
    AuthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
