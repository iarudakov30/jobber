import type { CodegenConfig } from '@graphql-codegen/cli';

// Typed GraphQL documents for the two backends the app calls, from the schema files they print
// on startup (no running server needed): `npx nx run nexus:codegen`. Write queries with the
// `graphql()` function of the matching output (src/gql/auth or src/gql/wallet); CI fails when
// the generated files are stale.
const shared = {
  preset: 'client' as const,
  presetConfig: { fragmentMasking: false },
  config: {
    useTypeImports: true,
    enumsAsTypes: true,
    // MinorUnits: a decimal string of minor units; parse it with @jobber/money.
    scalars: { MinorUnits: 'string', DateTime: 'string' },
  },
};

const config: CodegenConfig = {
  overwrite: true,
  generates: {
    'src/gql/auth/': {
      ...shared,
      schema: '../auth/schema.gql',
      documents: ['src/features/auth/**/*.{ts,tsx}', '!src/**/*.spec.{ts,tsx}'],
    },
    'src/gql/wallet/': {
      ...shared,
      schema: '../wallet/schema.gql',
      documents: [
        'src/features/wallet/**/*.{ts,tsx}',
        '!src/**/*.spec.{ts,tsx}',
      ],
    },
  },
};

export default config;
