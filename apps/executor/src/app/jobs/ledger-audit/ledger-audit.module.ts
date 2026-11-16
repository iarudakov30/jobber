import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import { PulsarModule } from '@jobber/pulsar';
import { JobClientsModule } from '../job-clients.module';
import { LedgerAuditConsumer } from './ledger-audit.consumer';

@Module({
  imports: [
    PulsarModule,
    JobClientsModule,
    ClientsModule.registerAsync([
      {
        name: Packages.WALLET,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            // Optional: deployments without the wallet (docker-compose.apps.yaml, the Helm chart)
            // still start; the client only connects when a LedgerAudit message arrives.
            url:
              configService.get<string>('WALLET_GRPC_SERVICE_URL') ??
              'localhost:5003',
            package: Packages.WALLET,
            protoPath: join(__dirname, '../../libs/grpc/proto/wallet.proto'),
            loader: GRPC_LOADER_OPTIONS,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [LedgerAuditConsumer],
})
export class LedgerAuditModule {}
