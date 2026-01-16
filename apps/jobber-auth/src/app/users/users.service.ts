import { Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';

import { Prisma, User as UserPrisma } from '@prisma-clients/jobber-auth';

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

  async createUser(data: Prisma.UserCreateInput): Promise<User> {
    return this.prismaService.user.create({
      data: {
        ...data,
        password: await hash(data.password, 10),
      },
    });
  }
}
