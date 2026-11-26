import {
  Field,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { IsIn, IsOptional, IsString, ValidateBy } from 'class-validator';
import { TradeSideEnum } from '../../market/models/market.models';
import { MinorUnits } from '../../market/models/minor-units.scalar';
import { TRADE_SIDES, TradeSide } from '../../market/pricing';
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  OrderRow,
  OrderStatus,
  OrderType,
} from '../schema';

export const OrderTypeEnum = Object.fromEntries(
  ORDER_TYPES.map((t) => [t, t]),
) as { [T in OrderType]: T };
registerEnumType(OrderTypeEnum, { name: 'OrderType' });

export const OrderStatusEnum = Object.fromEntries(
  ORDER_STATUSES.map((s) => [s, s]),
) as { [S in OrderStatus]: S };
registerEnumType(OrderStatusEnum, {
  name: 'OrderStatus',
  valuesMap: {
    PLACING: {
      description: "A limit order whose funds the wallet hasn't held yet.",
    },
    OPEN: { description: 'A limit order waiting for its price.' },
    SETTLING: {
      description: 'Being settled with the wallet; becomes FILLED.',
    },
    FILLED: {},
    CANCELLED: {},
    EXPIRED: { description: 'A limit order that stayed open for 24 hours.' },
    REJECTED: { description: 'Refused by the wallet; see reason.' },
  },
});

/**
 * Also keeps the field: the global `ValidationPipe({ whitelist: true })` strips any property
 * without a class-validator decorator. Which fields an order type needs is the service's job.
 */
function IsBigInt(): PropertyDecorator {
  return ValidateBy({
    name: 'isBigInt',
    validator: {
      validate: (value: unknown) => typeof value === 'bigint',
      defaultMessage: (args) => `${args?.property} must be an amount`,
    },
  });
}

@InputType({
  description:
    'A market order needs only quoteId. A limit order needs coin, side, qty and limitPrice.',
})
export class PlaceOrderInput {
  @Field(() => OrderTypeEnum)
  @IsIn(ORDER_TYPES)
  type: OrderType;

  @Field(() => ID, {
    nullable: true,
    description: 'Market orders: the quote to trade at (valid for 10 s, once).',
  })
  @IsOptional()
  @IsString()
  quoteId?: string | null;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  coin?: string | null;

  @Field(() => TradeSideEnum, { nullable: true })
  @IsOptional()
  @IsIn(TRADE_SIDES)
  side?: TradeSide | null;

  @Field(() => MinorUnits, {
    nullable: true,
    description: 'Coin minor units (8 decimals).',
  })
  @IsOptional()
  @IsBigInt()
  qty?: bigint | null;

  @Field(() => MinorUnits, {
    nullable: true,
    description: 'USD cents per whole coin.',
  })
  @IsOptional()
  @IsBigInt()
  limitPrice?: bigint | null;
}

@ObjectType({
  description:
    'A market or limit order. Amounts in USD cents; qty in coin minor units (8 decimals).',
})
export class Order {
  @Field(() => ID)
  id: string;

  @Field(() => OrderTypeEnum)
  type: OrderType;

  @Field()
  coin: string;

  @Field(() => TradeSideEnum)
  side: TradeSide;

  @Field(() => MinorUnits)
  qty: bigint;

  @Field(() => MinorUnits, { nullable: true })
  limitPrice: bigint | null;

  @Field(() => MinorUnits, {
    nullable: true,
    description:
      'USD cents per whole coin the order trades at: the quote price, or the limit price once matched.',
  })
  fillPrice: bigint | null;

  @Field(() => MinorUnits, { description: 'price × qty, before the fee.' })
  usdAmount: bigint;

  @Field(() => MinorUnits)
  fee: bigint;

  @Field(() => MinorUnits, {
    description:
      'What the trade costs (buy: usdAmount + fee) or pays (sell: usdAmount − fee).',
  })
  total: bigint;

  @Field(() => OrderStatusEnum)
  status: OrderStatus;

  @Field(() => String, { nullable: true })
  reason: string | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When an open limit order expires.',
  })
  expiresAt: Date | null;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    type: row.type,
    coin: row.coin,
    side: row.side,
    qty: row.qty,
    limitPrice: row.limitPrice,
    fillPrice: row.fillPrice,
    usdAmount: row.usdAmount,
    fee: row.fee,
    total:
      row.side === 'BUY' ? row.usdAmount + row.fee : row.usdAmount - row.fee,
    status: row.status,
    reason: row.reason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
