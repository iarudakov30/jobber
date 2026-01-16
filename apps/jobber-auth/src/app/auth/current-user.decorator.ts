import { createParamDecorator } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GqlContext } from '@jobber/nestjs';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: GqlExecutionContext) => {
    return GqlExecutionContext.create(ctx).getContext<GqlContext>().req.user;
  }
);
