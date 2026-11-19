import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import { MoneyFormatError, fromWire, toWire } from '@jobber/money';

function parse(value: string): bigint {
  try {
    return fromWire(value);
  } catch (error) {
    if (error instanceof MoneyFormatError) {
      throw new GraphQLError(`MinorUnits ${error.message}`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    throw error;
  }
}

/**
 * Money on the GraphQL wire: a decimal string of minor units ("1250" is $12.50 in USD), a
 * `bigint` in resolvers. A JSON number is refused, because clients would read and write it as
 * a float.
 */
export const MinorUnits = new GraphQLScalarType<bigint, string>({
  name: 'MinorUnits',
  description:
    'An amount in minor units of its asset, as a decimal string: "1250" is $12.50.',
  serialize(value) {
    if (typeof value !== 'bigint') {
      throw new GraphQLError(
        `MinorUnits must be a bigint, got ${typeof value}`,
      );
    }
    return toWire(value);
  },
  parseValue(value) {
    if (typeof value !== 'string') {
      throw new GraphQLError('MinorUnits must be a string such as "1250"', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return parse(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError('MinorUnits must be a string such as "1250"', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return parse(ast.value);
  },
});
