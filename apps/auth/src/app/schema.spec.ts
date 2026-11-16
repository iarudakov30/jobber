import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { readFileSync } from 'fs';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { join } from 'path';
import { AuthResolver } from './auth/auth.resolver';
import { UsersResolver } from './users/users.resolver';

// apps/auth/schema.gql is what the app prints on startup (autoSchemaFile, sortSchema) and what
// the React app's GraphQL Codegen reads. Rebuilding it from the resolvers needs no database or
// server, so a stale committed file fails here.
describe('apps/auth/schema.gql', () => {
  it('matches the schema the resolvers define', async () => {
    const app = await NestFactory.create(GraphQLSchemaBuilderModule, {
      logger: false,
    });
    await app.init();
    const schema = await app
      .get(GraphQLSchemaFactory)
      .create([AuthResolver, UsersResolver]);
    await app.close();

    const committed = readFileSync(join(__dirname, '../../schema.gql'), 'utf8');
    // Nest prefixes the printed schema with a "generated" banner.
    const body = committed.replace(/^(#[^\n]*\n)+\n/, '');
    expect(body).toBe(printSchema(lexicographicSortSchema(schema)));
  });
});
