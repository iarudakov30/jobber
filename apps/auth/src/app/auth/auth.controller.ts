import { Controller, Logger, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  AuthenticateRequest,
  AuthServiceController,
  AuthServiceControllerMethods,
  User,
} from '@jobber/grpc';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { TokenPayload } from './token-payload.interface';

@Controller()
@AuthServiceControllerMethods()
export class AuthController implements AuthServiceController {
  private readonly logger: Logger = new Logger(AuthController.name);

  constructor(private readonly usersService: UsersService) {}

  // @GrpcMethod('AuthService', 'authenticate') - another way to define it directly, without proto-ts package
  @UseGuards(JwtAuthGuard)
  authenticate(
    request: AuthenticateRequest & { user: TokenPayload }
  ): Promise<User> | Observable<User> | User {
    this.logger.log(request.user);
    return this.usersService.getUser({ id: request.user.userId });
  }
}
