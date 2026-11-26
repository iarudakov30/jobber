import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  GrpcStatus,
  HoldRequest,
  Packages,
  PostingResult,
  SettleTradeRequest,
  WALLET_SERVICE_NAME,
  WalletServiceClient,
} from '@jobber/grpc';

/** How long one wallet call may take before its outcome counts as unknown. */
export const WALLET_CALL_TIMEOUT_MS = 5_000;

/**
 * The wallet answered and wrote nothing: too few funds (`FAILED_PRECONDITION`), a hold that
 * isn't active or doesn't exist, or a request it found malformed. Retrying won't change it.
 */
export class WalletRefusedError extends Error {
  override readonly name = 'WalletRefusedError';

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }

  get insufficientFunds(): boolean {
    return this.code === GrpcStatus.FAILED_PRECONDITION;
  }
}

/**
 * No answer, or one that doesn't say what happened (timeout, connection lost, wallet error).
 * The wallet may or may not have committed: retry with the same id, which it makes safe.
 */
export class WalletUnavailableError extends Error {
  override readonly name = 'WalletUnavailableError';
}

const REFUSALS = new Set<number>([
  GrpcStatus.FAILED_PRECONDITION,
  GrpcStatus.INVALID_ARGUMENT,
  GrpcStatus.NOT_FOUND,
]);

/** The three wallet RPCs the market uses, with their errors sorted into refused and unknown. */
@Injectable()
export class WalletClient implements OnModuleInit {
  private wallet!: WalletServiceClient;

  constructor(@Inject(Packages.WALLET) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.wallet =
      this.client.getService<WalletServiceClient>(WALLET_SERVICE_NAME);
  }

  settleTrade(request: SettleTradeRequest): Promise<PostingResult> {
    return this.call(() => this.wallet.settleTrade(request));
  }

  placeHold(request: HoldRequest): Promise<PostingResult> {
    return this.call(() => this.wallet.placeHold(request));
  }

  releaseHold(holdId: string): Promise<PostingResult> {
    return this.call(() => this.wallet.releaseHold({ holdId }));
  }

  private async call(
    rpc: () => ReturnType<WalletServiceClient['settleTrade']>,
  ): Promise<PostingResult> {
    try {
      return await firstValueFrom(
        rpc().pipe(timeout({ first: WALLET_CALL_TIMEOUT_MS })),
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'number' && REFUSALS.has(code)) {
        const details = (error as { details?: unknown }).details;
        throw new WalletRefusedError(
          code,
          typeof details === 'string' && details
            ? details
            : (error as Error).message,
        );
      }
      throw new WalletUnavailableError(
        `wallet call failed: ${(error as Error)?.message ?? String(error)}`,
      );
    }
  }
}
