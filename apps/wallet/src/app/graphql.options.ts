import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GqlLoggingPlugin } from '@jobber/graphql';

/**
 * The wallet's GraphQL setup (code-first, like jobs), served at `/wallet`. The schema is
 * printed to `autoSchemaFile` on startup: `apps/wallet/schema.gql` in the app, so the React
 * app's codegen works without a running server.
 */
export function graphQLOptions(
  autoSchemaFile: string | boolean,
): ApolloDriverConfig {
  return {
    driver: ApolloDriver,
    plugins: [new GqlLoggingPlugin()],
    graphiql: true,
    path: 'wallet',
    playground: false,
    context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
    autoSchemaFile,
    sortSchema: true,
  };
}
