import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GqlContext } from '@jobber/graphql';
import { User } from '@jobber/grpc';

/** The user `GqlAuthGuard` resolved from the `Authentication` cookie. */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): User =>
    GqlExecutionContext.create(context).getContext<GqlContext>().req
      .user as User,
);
