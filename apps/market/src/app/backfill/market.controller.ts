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
import { isSimulated } from '../prices/coins';
import { CandleStore } from '../prices/candle.store';

/**
 * gRPC `MarketService`, for the `BackfillCandles` job's consumer in the executor. Any replica
 * serves it: generated candles are the same everywhere and only fill minutes that have none.
 */
@Controller()
@MarketServiceControllerMethods()
@UseInterceptors(GrpcLoggingInterceptor)
export class MarketController implements MarketServiceController {
  private readonly logger = new Logger(MarketController.name);

  constructor(private readonly candles: CandleStore) {}

  async generateCandles({
    coin,
    day,
  }: GenerateCandlesRequest): Promise<GenerateCandlesResult> {
    if (!isCoin(coin)) {
      throw invalid(`coin must be one of: ${COINS.join(', ')}`);
    }
    if (!isSimulated(coin)) {
      // Phase 4.5 step 4 loads their real candles from the exchanges.
      throw invalid(
        `coin ${coin} is priced by the exchanges: its history isn't generated`,
      );
    }
    let generated;
    try {
      generated = generateDay(coin, day);
    } catch (error) {
      if (error instanceof BackfillDayError) {
        throw invalid(error.message);
      }
      throw error;
    }
    const written = await this.candles.insertMissing(generated);
    this.logger.log(
      `GenerateCandles ${coin} ${day}: ${written} of ${generated.length} minutes written`,
    );
    return { written };
  }
}

function invalid(message: string): RpcException {
  return new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });
}
