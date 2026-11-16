import { Controller, UseInterceptors } from '@nestjs/common';
import {
  AuditResult,
  Balances,
  CreditRequest,
  GetBalancesRequest,
  GrpcLoggingInterceptor,
  PostingResult,
  WalletServiceController,
  WalletServiceControllerMethods,
} from '@jobber/grpc';
import { fromWire, toWire } from '@jobber/money';
import { LedgerService } from '../ledger/ledger.service';
import { asRpc } from './wallet.errors';
import { WalletService } from './wallet.service';

/** gRPC `WalletService`, for other services. Amounts are decimal strings of minor units. */
@Controller()
@WalletServiceControllerMethods()
@UseInterceptors(GrpcLoggingInterceptor)
export class WalletController implements WalletServiceController {
  constructor(
    private readonly wallet: WalletService,
    private readonly ledger: LedgerService,
  ) {}

  credit(request: CreditRequest): Promise<PostingResult> {
    return asRpc(() =>
      this.wallet.credit({ ...request, amount: fromWire(request.amount) }),
    );
  }

  getBalances({ userId }: GetBalancesRequest): Promise<Balances> {
    return asRpc(async () => ({
      balances: (await this.wallet.balances(userId)).map((b) => ({
        asset: b.asset,
        available: toWire(b.available),
        held: toWire(b.held),
      })),
    }));
  }

  async runAudit(): Promise<AuditResult> {
    return { issues: await this.ledger.audit() };
  }
}
