import { Controller, UseInterceptors } from '@nestjs/common';
import {
  AuditResult,
  Balances,
  CreditRequest,
  GetBalancesRequest,
  GrpcLoggingInterceptor,
  HoldRef,
  HoldRequest,
  PostingResult,
  SettleTradeRequest,
  WalletServiceController,
  WalletServiceControllerMethods,
} from '@jobber/grpc';
import { fromWire, toWire } from '@jobber/money';
import { LedgerService } from '../ledger/ledger.service';
import { TradingService } from '../trading/trading.service';
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
    private readonly trading: TradingService,
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

  // Trading RPCs for the market. Each is idempotent by its id: a retry returns the first
  // posting with duplicate: true.
  settleTrade(request: SettleTradeRequest): Promise<PostingResult> {
    return asRpc(() =>
      this.trading.settleTrade({
        ...request,
        qty: fromWire(request.qty),
        usdAmount: fromWire(request.usdAmount),
        fee: fromWire(request.fee),
      }),
    );
  }

  placeHold(request: HoldRequest): Promise<PostingResult> {
    return asRpc(() =>
      this.trading.placeHold({ ...request, amount: fromWire(request.amount) }),
    );
  }

  releaseHold({ holdId }: HoldRef): Promise<PostingResult> {
    return asRpc(() => this.trading.releaseHold(holdId));
  }
}
