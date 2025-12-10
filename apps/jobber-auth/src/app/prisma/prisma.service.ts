import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma-clients/jobber-auth';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.AUTH_DATABASE_URL,
});

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
