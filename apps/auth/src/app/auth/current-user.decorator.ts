import { createParamDecorator } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GqlContext } from '@jobber/graphql';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: GqlExecutionContext) => {
    return GqlExecutionContext.create(ctx).getContext<GqlContext>().req.user;
  }
);
