import { Controller, Logger, UseInterceptors } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  GenerateCandlesRequest,
  GenerateCandlesResult,
  GrpcLoggingInterceptor,
  GrpcStatus,
  MarketServiceController,
  MarketServiceControllerMethods,
} from '@jobber/grpc';
import { COINS, isCoin } from '@jobber/money';
import { BackfillDayError, generateDay } from '../prices/backfill';
import { LiveCoin, SimulatedCoin, isLive } from '../prices/coins';
import { CandleStore } from '../prices/candle.store';
import {
  HistoryUnavailableError,
  LiveHistory,
  LivePricesOffError,
} from '../prices/live/live-history';

/**
 * gRPC `MarketService`, for the `BackfillCandles` job's consumer in the executor. Any replica
 * serves it, and only minutes that have no candle are written. A simulated coin's day is
 * generated (the same everywhere); a live coin's is loaded from the exchanges (`LiveHistory`).
 */
@Controller()
@MarketServiceControllerMethods()
@UseInterceptors(GrpcLoggingInterceptor)
export class MarketController implements MarketServiceController {
  private readonly logger = new Logger(MarketController.name);

  constructor(
    private readonly candles: CandleStore,
    private readonly history: LiveHistory,
  ) {}

  async generateCandles({
    coin,
    day,
  }: GenerateCandlesRequest): Promise<GenerateCandlesResult> {
    if (!isCoin(coin)) {
      throw rpcError(
        GrpcStatus.INVALID_ARGUMENT,
        `coin must be one of: ${COINS.join(', ')}`,
      );
    }
    try {
      return isLive(coin)
        ? await this.load(coin, day)
        : await this.generate(coin, day);
    } catch (error) {
      if (error instanceof BackfillDayError) {
        throw rpcError(GrpcStatus.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof LivePricesOffError) {
        throw rpcError(GrpcStatus.FAILED_PRECONDITION, error.message);
      }
      if (error instanceof HistoryUnavailableError) {
        throw rpcError(GrpcStatus.UNAVAILABLE, error.message);
      }
      throw error;
    }
  }

  private async generate(
    coin: SimulatedCoin,
    day: string,
  ): Promise<GenerateCandlesResult> {
    const generated = generateDay(coin, day);
    const written = await this.candles.insertMissing(generated);
    this.logger.log(
      `GenerateCandles ${coin} ${day}: ${written} of ${generated.length} minutes written`,
    );
    return { written };
  }

  private async load(
    coin: LiveCoin,
    day: string,
  ): Promise<GenerateCandlesResult> {
    const { written, candles, provider } = await this.history.loadDay(
      coin,
      day,
    );
    this.logger.log(
      `GenerateCandles ${coin} ${day}: ${written} of ${candles} minutes from ${provider} written`,
    );
    return { written };
  }
}

function rpcError(code: number, message: string): RpcException {
  return new RpcException({ code, message });
}
