import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  GrpcStatus,
  MARKET_SERVICE_NAME,
  MarketServiceClient,
  Packages,
} from '@jobber/grpc';
import { Jobs } from '@jobber/nestjs';
import {
  BackfillCandlesMessage,
  NonRetryableError,
  PulsarClient,
} from '@jobber/pulsar';
import { JobsConsumer } from '../jobs.consumer';

/**
 * Writes one coin-day of 1-minute candles: the market's gRPC `GenerateCandles` (generated for a
 * simulated coin, from the exchanges for a live one). The market writes only minutes without a
 * candle, so a redelivered message writes nothing. A day the market refuses
 * (`INVALID_ARGUMENT`) or can't load as configured (`FAILED_PRECONDITION`: live prices off) is
 * dead-lettered at once; an unreachable market, or exchanges that all refuse (`UNAVAILABLE`),
 * are retried by Pulsar's redelivery.
 */
@Injectable()
export class BackfillCandlesConsumer
  extends JobsConsumer<BackfillCandlesMessage>
  implements OnModuleInit
{
  private market!: MarketServiceClient;

  constructor(
    pulsarClient: PulsarClient,
    @Inject(Packages.JOBS) clientJobs: ClientGrpc,
    @Inject(Packages.MARKET) private readonly clientMarket: ClientGrpc,
  ) {
    super(Jobs.BACKFILL_CANDLES, pulsarClient, clientJobs);
  }

  async onModuleInit(): Promise<void> {
    this.market =
      this.clientMarket.getService<MarketServiceClient>(MARKET_SERVICE_NAME);
    await super.onModuleInit();
  }

  protected async execute({
    jobId,
    coin,
    day,
  }: BackfillCandlesMessage): Promise<void> {
    try {
      const { written } = await firstValueFrom(
        this.market.generateCandles({ coin, day }),
      );
      this.logger.log(
        `Backfill (job ${jobId}) ${coin} ${day}: ${written} candle(s) written`,
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        code === GrpcStatus.INVALID_ARGUMENT ||
        code === GrpcStatus.FAILED_PRECONDITION
      ) {
        throw new NonRetryableError(
          `The market refused ${coin} ${day}: ${(error as { details?: string }).details}`,
        );
      }
      throw error;
    }
  }
}
