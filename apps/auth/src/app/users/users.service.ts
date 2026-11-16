import { Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';

import { Prisma, User as UserPrisma } from '../../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { User } from './models/user.model';

@Injectable()
export class UsersService {
  constructor(private readonly prismaService: PrismaService) {}

  async getUsers(): Promise<User[]> {
    return this.prismaService.user.findMany({ omit: { password: true } });
  }

  async getUser(args: Prisma.UserWhereUniqueInput): Promise<UserPrisma> {
    return this.prismaService.user.findUniqueOrThrow({ where: args });
  }

  /** Exact match, like login; null when nobody has that email. */
  async findByEmail(email: string): Promise<User | null> {
    return this.prismaService.user.findUnique({
      where: { email },
      omit: { password: true },
    });
  }

  async createUser(data: Prisma.UserCreateInput): Promise<User> {
    return this.prismaService.user.create({
      data: {
        ...data,
        password: await hash(data.password, 10),
      },
    });
  }
}
