import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { Response } from 'express';
import { compare } from 'bcryptjs';

import { User as UserPrisma } from '@prisma-clients/jobber-auth';

import { UsersService } from '../users/users.service';
import { User } from '../users/models/user.model';

import { LoginInput } from './dto/login.input';
import { TokenPayload } from './token-payload.interface';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService
  ) {}
  async login(
    { email, password }: LoginInput,
    response: Response
  ): Promise<User> {
    const user: UserPrisma = await this.verifyUser(email, password);

    const expires = new Date();
    expires.setMilliseconds(
      expires.getTime() +
        parseInt(this.configService.getOrThrow('JWT_EXPIRATION_MS'))
    );
    const tokenPayload: TokenPayload = {
      userId: user.id,
    };
    const accessToken: string = this.jwtService.sign(tokenPayload);
    response.cookie('Authentication', accessToken, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      expires,
    });

    return {
      email: user.email,
      id: user.id,
    };
  }

  private async verifyUser(
    email: string,
    password: string
  ): Promise<UserPrisma> {
    try {
      const user: UserPrisma = await this.usersService.getUser({ email });
      const authenticated = await compare(password, user.password);
      if (!authenticated) {
        throw new UnauthorizedException();
      }
      return user;
    } catch (err) {
      throw new UnauthorizedException('Credentials are not valid');
    }
  }
}
