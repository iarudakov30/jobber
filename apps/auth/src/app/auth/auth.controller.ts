import { Controller, Logger, UseGuards, UseInterceptors } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import {
  AuthenticateRequest,
  AuthServiceController,
  AuthServiceControllerMethods,
  FindUserByEmailRequest,
  GetUserRequest,
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

  /** Called by other services (the email worker, for the recipient's address). */
  async getUser({ id }: GetUserRequest): Promise<User> {
    // proto3 sends 0 for a missing field, so a caller that forgot the id lands here.
    if (!Number.isInteger(id) || id < 1) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'id must be a positive integer',
      });
    }
    const user = await this.usersService.findById(id);
    if (!user) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: 'No user has that id',
      });
    }
    return { id: user.id, email: user.email };
  }
}
