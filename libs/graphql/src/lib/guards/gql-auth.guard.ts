import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Observable, map, catchError, of } from 'rxjs';
import { GqlContext } from '../interfaces/gql-context.interface';
import {
  AUTH_PACKAGE_NAME,
  AUTH_SERVICE_NAME,
  AuthServiceClient,
  User,
} from '@jobber/grpc';

@Injectable()
export class GqlAuthGuard implements CanActivate, OnModuleInit {
  private authService: AuthServiceClient;
  private readonly logger = new Logger(GqlAuthGuard.name);

  constructor(@Inject(AUTH_PACKAGE_NAME) private client: ClientGrpc) {}

  onModuleInit(): any {
    this.authService =
      this.client.getService<AuthServiceClient>(AUTH_SERVICE_NAME);
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const token = this.getRequest(context).cookies?.Authentication;
    if (!token) {
      return false;
    }

    return this.authService.authenticate({ token }).pipe(
      map((user: User) => {
        this.getRequest(context).user = user;
        return true;
      }),
      catchError((err) => {
        this.logger.error(err);
        return of(false);
      }),
    );
  }

  private getRequest(context: ExecutionContext) {
    const ctx: GqlExecutionContext = GqlExecutionContext.create(context);
    return ctx.getContext<GqlContext>().req;
  }
}
