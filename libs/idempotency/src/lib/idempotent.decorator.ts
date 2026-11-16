import {
  ExecutionContext,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';

import {
  IDEMPOTENT_OPTIONS,
  IdempotencyInterceptor,
} from './idempotency.interceptor';
import {
  IdempotencyRequestContext,
  IdempotentOptions,
} from './idempotency.types';

/**
 * Makes a GraphQL mutation or HTTP handler idempotent by its `Idempotency-Key` header (see
 * `IdempotencyInterceptor`). The module must provide `IDEMPOTENCY_STORE` (and optionally
 * `IDEMPOTENCY_LOCK`).
 */
export function Idempotent(options: IdempotentOptions = {}) {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_OPTIONS, options),
    UseInterceptors(IdempotencyInterceptor),
  );
}

/** The current request's `Idempotency-Key`, inside an `@Idempotent()` handler. */
export const IdempotencyKey = createParamDecorator(
  (_: unknown, context: ExecutionContext): string | undefined => {
    const req =
      context.getType<GqlContextType>() === 'graphql'
        ? GqlExecutionContext.create(context).getContext().req
        : context.switchToHttp().getRequest();
    return (req?.idempotency as IdempotencyRequestContext | undefined)?.key;
  },
);
