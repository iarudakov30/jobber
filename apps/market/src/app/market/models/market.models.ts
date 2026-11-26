import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { TRADE_SIDES, TradeSide } from '../pricing';
import { MinorUnits } from './minor-units.scalar';

export const TradeSideEnum = Object.fromEntries(
  TRADE_SIDES.map((s) => [s, s]),
) as { [S in TradeSide]: S };

registerEnumType(TradeSideEnum, { name: 'TradeSide' });

@ObjectType({
  description:
    "A coin's price at one tick. Live ticks arrive on the realtime channel prices.<coin> with the same fields.",
})
export class PriceTick {
  @Field(() => MinorUnits, { description: 'USD cents per whole coin.' })
  price: bigint;

  @Field(() => Int, {
    description:
      "Increases with every tick of this coin: drop a live tick whose seq isn't higher.",
  })
  seq: number;

  @Field()
  at: Date;
}

@ObjectType()
export class Coin {
  @Field()
  code: string;

  @Field()
  name: string;

  @Field(() => PriceTick, {
    nullable: true,
    description: 'The latest price; null until the simulator has ticked once.',
  })
  tick: PriceTick | null;

  @Field(() => MinorUnits, {
    nullable: true,
    description:
      'The open of the first 1-minute candle in the last 24 hours, for the 24 h change; null without candles.',
  })
  open24h: bigint | null;
}

@ObjectType({
  description: "One minute of a coin's price, in USD cents per whole coin.",
})
export class Candle {
  @Field({ description: 'The start of the minute (UTC).' })
  start: Date;

  @Field(() => MinorUnits)
  open: bigint;

  @Field(() => MinorUnits)
  high: bigint;

  @Field(() => MinorUnits)
  low: bigint;

  @Field(() => MinorUnits)
  close: bigint;
}

@ObjectType({
  description:
    'A price for a market order, valid until expiresAt (10 s). Amounts in USD cents; qty in coin minor units (8 decimals).',
})
export class Quote {
  @Field(() => ID)
  id: string;

  @Field()
  coin: string;

  @Field(() => TradeSideEnum)
  side: TradeSide;

  @Field(() => MinorUnits)
  qty: bigint;

  @Field(() => MinorUnits, {
    description:
      'USD cents per whole coin: the mid price plus (buy) or minus (sell) 0.2%.',
  })
  price: bigint;

  @Field(() => MinorUnits, {
    description: 'price × qty, rounded up for a buy and down for a sell.',
  })
  usdAmount: bigint;

  @Field(() => MinorUnits, { description: '0.5% of usdAmount, rounded up.' })
  fee: bigint;

  @Field(() => MinorUnits, {
    description:
      'What you pay (buy: usdAmount + fee) or receive (sell: usdAmount − fee).',
  })
  total: bigint;

  @Field()
  expiresAt: Date;
}
