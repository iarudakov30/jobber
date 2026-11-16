import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { Observable, defer, lastValueFrom } from 'rxjs';

import { decodeResponse, encodeResponse, hashRequest } from './canonical';
import {
  IDEMPOTENCY_LOCK,
  IDEMPOTENCY_STORE,
  IdempotencyLock,
  IdempotencyRequestContext,
  IdempotencyStore,
  IdempotentOptions,
} from './idempotency.types';

export const IDEMPOTENT_OPTIONS = 'jobber:idempotent';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: unknown };
  idempotency?: IdempotencyRequestContext;
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

interface ResponseLike {
  setHeader?(name: string, value: string): void;
}

type Protocol = 'graphql' | 'http';

/**
 * Runs an `@Idempotent()` handler at most once per `Idempotency-Key`:
 *
 * 1. The key is required. Scope = `<userId>:<operation>:<key>`; the request hash is the SHA-256
 *    of the canonical JSON of the arguments (GraphQL args, or HTTP params + query + body).
 * 2. Redis `SET NX` (if configured and up): taken → 409 "in progress".
 * 3. The PostgreSQL claim decides: a different request under the key → 422; completed → the
 *    stored response (with `Idempotent-Replayed: true`); in progress → 409; else run.
 * 4. Success stores the response for `ttlMs`; failure releases the key so the client can retry.
 *
 * Runs after guards, so `req.user` is set; before pipes, so it hashes the raw arguments.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    @Optional()
    @Inject(IDEMPOTENCY_LOCK)
    private readonly lock?: IdempotencyLock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_OPTIONS,
      context.getHandler(),
    );
    if (!options) {
      return next.handle();
    }
    return defer(() => this.run(context, next, options));
  }

  private async run(
    context: ExecutionContext,
    next: CallHandler,
    options: IdempotentOptions,
  ): Promise<unknown> {
    const { protocol, req, res, args } = requestOf(context);
    const header = req.headers[IDEMPOTENCY_KEY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !KEY_PATTERN.test(key)) {
      throw error(
        protocol,
        400,
        'BAD_REQUEST',
        'Idempotency-Key header is required: 1 to 255 visible ASCII characters',
      );
    }
    const operation =
      options.operation ??
      `${context.getClass().name}.${context.getHandler().name}`;
    const scope = `${req.user?.id ?? '-'}:${operation}:${key}`;
    const requestHash = hashRequest(args);
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

    const lock = this.lock
      ? await this.lock.acquire(scope, leaseMs)
      : ({ status: 'unavailable' } as const);
    if (lock.status === 'taken') {
      throw inProgress(protocol);
    }
    try {
      const claim = await this.store.claim(scope, requestHash, leaseMs);
      switch (claim.kind) {
        case 'mismatch':
          throw error(
            protocol,
            422,
            'UNPROCESSABLE_ENTITY',
            'Idempotency-Key was already used with a different request',
          );
        case 'in_progress':
          throw inProgress(protocol);
        case 'replay':
          res?.setHeader?.(REPLAYED_HEADER, 'true');
          return decodeResponse(claim.response);
      }

      req.idempotency = { key, scope };
      let result: unknown;
      try {
        result = await lastValueFrom(next.handle(), {
          defaultValue: undefined,
        });
      } catch (handlerError) {
        await this.store
          .release(scope, requestHash)
          .catch((e) => this.logger.error(`Releasing ${scope} failed: ${e}`));
        throw handlerError;
      }
      // The handler's effect is done: answer even if storing fails. A retry then waits out the
      // lease and runs the handler again, which must be safe (the wallet derives its ledger
      // externalRef from the key).
      await this.store
        .complete(
          scope,
          requestHash,
          encodeResponse(result),
          options.ttlMs ?? DEFAULT_TTL_MS,
        )
        .catch((e) => this.logger.error(`Completing ${scope} failed: ${e}`));
      return result;
    } finally {
      if (lock.status === 'acquired') {
        await this.lock?.release(scope, lock.token);
      }
    }
  }
}

function requestOf(context: ExecutionContext): {
  protocol: Protocol;
  req: RequestLike;
  res?: ResponseLike;
  args: unknown;
} {
  if (context.getType<GqlContextType>() === 'graphql') {
    const gql = GqlExecutionContext.create(context);
    const { req, res } = gql.getContext<{
      req: RequestLike;
      res?: ResponseLike;
    }>();
    return { protocol: 'graphql', req, res, args: gql.getArgs() };
  }
  const http = context.switchToHttp();
  const req = http.getRequest<RequestLike>();
  return {
    protocol: 'http',
    req,
    res: http.getResponse<ResponseLike>(),
    args: { params: req.params, query: req.query, body: req.body },
  };
}

function inProgress(protocol: Protocol): Error {
  return error(
    protocol,
    409,
    'CONFLICT',
    'A request with this Idempotency-Key is still in progress; retry later',
  );
}

/**
 * GraphQL gets a GraphQLError with an explicit code: Nest's Apollo driver maps only some HTTP
 * statuses to codes and would report a 409 as INTERNAL_SERVER_ERROR.
 */
function error(
  protocol: Protocol,
  status: number,
  code: string,
  message: string,
): Error {
  if (protocol === 'graphql') {
    return new GraphQLError(message, { extensions: { code, status } });
  }
  return new HttpException(
    { statusCode: status, error: code, message },
    status,
  );
}
