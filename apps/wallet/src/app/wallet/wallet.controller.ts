import { Controller, UseInterceptors } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  AuditResult,
  Balances,
  CreditRequest,
  GetBalancesRequest,
  GrpcLoggingInterceptor,
  GrpcStatus,
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

  // Trading RPCs: the contract is in wallet.proto; phase 4 step 2 implements them.
  settleTrade(): never {
    throw notYet('SettleTrade');
  }

  placeHold(): never {
    throw notYet('PlaceHold');
  }

  releaseHold(): never {
    throw notYet('ReleaseHold');
  }
}

function notYet(rpc: string): RpcException {
  return new RpcException({
    code: GrpcStatus.UNIMPLEMENTED,
    message: `${rpc} is not implemented yet`,
  });
}
