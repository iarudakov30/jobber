import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { GqlContext } from '@jobber/nestjs';
import { User } from '../users/models/user.model';
import { LoginInput } from './dto/login.input';
import { AuthService } from './auth.service';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => User)
  async login(
    @Args('loginInput') loginInput: LoginInput,
    @Context() context: GqlContext
  ): Promise<User> {
    return this.authService.login(loginInput, context.res);
  }
}
