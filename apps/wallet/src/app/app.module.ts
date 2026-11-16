import { Module } from '@nestjs/common';
import { LoggerModule } from '@jobber/nestjs';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { LedgerModule } from './ledger/ledger.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    LedgerModule,
  ],
})
export class AppModule {}
