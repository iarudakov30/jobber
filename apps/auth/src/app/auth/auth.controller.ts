import { Controller, Logger, UseGuards, UseInterceptors } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import {
  AuthenticateRequest,
  AuthServiceController,
  AuthServiceControllerMethods,
  FindUserByEmailRequest,
  GrpcLoggingInterceptor,
  GrpcStatus,
  User,
} from '@jobber/grpc';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { TokenPayload } from './token-payload.interface';

@Controller()
@AuthServiceControllerMethods()
@UseInterceptors(GrpcLoggingInterceptor)
export class AuthController implements AuthServiceController {
  private readonly logger: Logger = new Logger(AuthController.name);

  constructor(private readonly usersService: UsersService) {}

  // @GrpcMethod('AuthService', 'authenticate') - another way to define it directly, without proto-ts package
  @UseGuards(JwtAuthGuard)
  authenticate(
    request: AuthenticateRequest & { user: TokenPayload },
  ): Promise<User> | Observable<User> | User {
    this.logger.log(request.user);
    return this.usersService.getUser({ id: request.user.userId });
  }

  /** Called by other services (wallet, for transfers by email); the caller checks the JWT. */
  async findUserByEmail({ email }: FindUserByEmailRequest): Promise<User> {
    const user = await this.usersService.findByEmail(email.trim());
    if (!user) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: 'No user has that email',
      });
    }
    return { id: user.id, email: user.email };
  }
}
