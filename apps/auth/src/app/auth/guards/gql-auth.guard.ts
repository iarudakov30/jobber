import { AuthGuard } from '@nestjs/passport';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GqlContext } from '@jobber/graphql';

@Injectable()
export class GqlAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext) {
    console.log('GqlAuthGuard');
    const ctx: GqlExecutionContext = GqlExecutionContext.create(context);
    return ctx.getContext<GqlContext>().req;
  }
}
