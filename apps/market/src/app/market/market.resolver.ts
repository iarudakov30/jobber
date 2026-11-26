import { UseGuards } from '@nestjs/common';
import {
  Args,
  GraphQLISODateTime,
  Mutation,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { GqlAuthGuard } from '@jobber/graphql';
import { User } from '@jobber/grpc';
import { CurrentUser } from './current-user.decorator';
import { asGraphQL } from './market.errors';
import { MarketService } from './market.service';
import { Candle, Coin, Quote, TradeSideEnum } from './models/market.models';
import { MinorUnits } from './models/minor-units.scalar';
import { TradeSide } from './pricing';

/** Market data is public; quotes (and, from step 4, orders) need a signed-in user. */
@Resolver()
export class MarketResolver {
  constructor(private readonly service: MarketService) {}

  @Query(() => [Coin], {
    description: 'Every coin with its latest price, in a fixed order.',
  })
  coins(): Promise<Coin[]> {
    return asGraphQL(() => this.service.coins());
  }

  @Query(() => [Candle], {
    description:
      "A coin's 1-minute candles with from <= start < to, oldest first. Defaults: to = now, from = 24 hours before to; at most 24 hours. The minute in progress isn't included: build it from live ticks.",
  })
  candles(
    @Args('coin') coin: string,
    @Args('from', { type: () => GraphQLISODateTime, nullable: true })
    from?: Date | null,
    @Args('to', { type: () => GraphQLISODateTime, nullable: true })
    to?: Date | null,
  ): Promise<Candle[]> {
    return asGraphQL(() => this.service.candles(coin, from, to));
  }

  @Mutation(() => Quote, {
    description:
      'Prices a market order. The quote holds for 10 s; placing the order with its id (step 4) gets exactly these amounts.',
  })
  @UseGuards(GqlAuthGuard)
  quote(
    @CurrentUser() user: User,
    @Args('coin') coin: string,
    @Args('side', { type: () => TradeSideEnum }) side: TradeSide,
    @Args('qty', { type: () => MinorUnits }) qty: bigint,
  ): Promise<Quote> {
    return asGraphQL(() => this.service.quote(user.id, coin, side, qty));
  }
}
