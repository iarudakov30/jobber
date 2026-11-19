import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GqlLoggingPlugin } from '@jobber/graphql';

/**
 * The payments GraphQL setup (code-first, like wallet), served at `/payments`. The schema is
 * printed to `autoSchemaFile` on startup: `apps/payments/schema.gql` in the app, so the React
 * app's codegen works without a running server.
 */
export function graphQLOptions(
  autoSchemaFile: string | boolean,
): ApolloDriverConfig {
  return {
    driver: ApolloDriver,
    plugins: [new GqlLoggingPlugin()],
    graphiql: true,
    path: 'payments',
    playground: false,
    context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
    autoSchemaFile,
    sortSchema: true,
  };
}
