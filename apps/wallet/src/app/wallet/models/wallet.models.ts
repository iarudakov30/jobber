import { Field, ID, ObjectType } from '@nestjs/graphql';
import { MinorUnits } from './minor-units.scalar';

@ObjectType({ description: "One asset's balances for the signed-in user." })
export class Balance {
  @Field()
  asset: string;

  @Field(() => MinorUnits, { description: 'Spendable now.' })
  available: bigint;

  @Field(() => MinorUnits, { description: 'Reserved, e.g. by open orders.' })
  held: bigint;
}

@ObjectType({ description: "A line of the user's history: one ledger entry." })
export class LedgerEntry {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  transactionId: string;

  @Field({ description: "The posting's kind: 'seed', 'transfer', ..." })
  type: string;

  @Field()
  asset: string;

  @Field(() => MinorUnits, { description: 'Negative when money left.' })
  amount: bigint;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class EntryPage {
  @Field(() => [LedgerEntry], { description: 'Newest first.' })
  items: LedgerEntry[];

  @Field(() => ID, {
    nullable: true,
    description: 'Pass as `after` for the next page; null on the last page.',
  })
  nextCursor: string | null;
}

@ObjectType()
export class Transfer {
  @Field(() => ID)
  transactionId: string;

  @Field(() => MinorUnits)
  amount: bigint;

  @Field()
  asset: string;
}

@ObjectType({
  description:
    'A coin the signed-in user holds through trades, with its average cost (fees included).',
})
export class Position {
  @Field()
  coin: string;

  @Field(() => MinorUnits, { description: 'Coin minor units (8 decimals).' })
  qty: bigint;

  @Field(() => MinorUnits, {
    description: 'USD cents paid for qty, fees included.',
  })
  costBasis: bigint;

  @Field(() => MinorUnits, {
    description: 'USD cents per whole coin, rounded down.',
  })
  averagePrice: bigint;
}
