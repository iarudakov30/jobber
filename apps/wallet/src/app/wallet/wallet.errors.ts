import { RpcException } from '@nestjs/microservices';
import { GraphQLError } from 'graphql';
import { GrpcStatus } from '@jobber/grpc';
import { MoneyFormatError } from '@jobber/money';
import {
  InsufficientFundsError,
  InvalidPostingError,
} from '../ledger/ledger.errors';

/**
 * A request the caller can fix. Messages start with the input field they're about when there is
 * one ("amount must be positive"), like class-validator's, so the React forms can put them on
 * that field.
 */
export class WalletInputError extends Error {
  override readonly name = 'WalletInputError';
}

function isCallerError(error: unknown): error is Error {
  return (
    error instanceof WalletInputError ||
    error instanceof InvalidPostingError ||
    error instanceof MoneyFormatError
  );
}

/** Runs `fn`, reporting the caller's mistakes as GraphQL `BAD_USER_INPUT` errors. */
export async function asGraphQL<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw new GraphQLError('amount exceeds your available balance', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (isCallerError(error)) {
      throw new GraphQLError(error.message, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    throw error;
  }
}

/** Runs `fn`, reporting the caller's mistakes as gRPC `INVALID_ARGUMENT` / `FAILED_PRECONDITION`. */
export async function asRpc<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: error.message,
      });
    }
    if (isCallerError(error)) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: error.message,
      });
    }
    throw error;
  }
}
