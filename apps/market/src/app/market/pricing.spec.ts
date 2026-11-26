import { mulberry32 } from '../prices/random';
import {
  COIN_UNIT,
  FEE_BP,
  SPREAD_BP,
  TRADE_SIDES,
  TradeSide,
  feeFor,
  holdFor,
  limitAmounts,
  quoteAmounts,
  quotePrice,
  usdAmount,
} from './pricing';

const BP = 10_000n;

/** Fails with the case that broke the property, rather than "expected true". */
function holds(property: boolean, context: string): void {
  if (!property) {
    throw new Error(`Property violated for ${context}`);
  }
}

/** A random bigint in [1, max], with lengths spread so small and huge values both appear. */
function randomAmount(random: () => number, max: bigint): bigint {
  const digits = 1 + Math.floor(random() * max.toString().length);
  let value = 0n;
  for (let i = 0; i < digits; i++) {
    value = value * 10n + BigInt(Math.floor(random() * 10));
  }
  return (value % max) + 1n;
}

interface Case {
  mid: bigint;
  qty: bigint;
  side: TradeSide;
}

function* cases(count: number): Generator<Case> {
  const random = mulberry32(20_261_126);
  for (let i = 0; i < count; i++) {
    yield {
      mid: randomAmount(random, 100_000_000n), // up to $1,000,000 a coin
      qty: randomAmount(random, 1_000_000n * COIN_UNIT), // up to a million coins
      side: TRADE_SIDES[i % 2],
    };
  }
  // Edges: the smallest price and quantity, exact multiples, and amounts just past them.
  for (const mid of [1n, 2n, 99n, 100n, 101n, 4_200n, 10_000n]) {
    for (const qty of [
      1n,
      99n,
      COIN_UNIT - 1n,
      COIN_UNIT,
      COIN_UNIT + 1n,
      3n * COIN_UNIT,
    ]) {
      for (const side of TRADE_SIDES) {
        yield { mid, qty, side };
      }
    }
  }
}

// Acceptance test 2: rounding favours the house. "Exact" is the rational amount before any
// rounding: mid × (1 ± spread) × qty / 10^8, then ± the 0.5% fee.
describe('pricing (property test over 20,000 random prices and quantities)', () => {
  it('never lets a buyer pay less, or a seller get more, than the exact amount', () => {
    for (const { mid, qty, side } of cases(20_000)) {
      const {
        price,
        usdAmount: usd,
        fee,
        total,
      } = quoteAmounts(mid, side, qty);
      const context = `${side} ${qty} at mid ${mid}`;
      if (side === 'BUY') {
        // total ≥ mid · (1 + 0.2%) · qty / 10^8 · (1 + 0.5%)
        holds(
          total * COIN_UNIT * BP * BP >=
            mid * qty * (BP + SPREAD_BP) * (BP + FEE_BP),
          context,
        );
        holds(price * BP >= mid * (BP + SPREAD_BP), context);
        holds(usd * COIN_UNIT >= price * qty, context);
      } else {
        // total ≤ mid · (1 − 0.2%) · qty / 10^8 · (1 − 0.5%)
        holds(
          total * COIN_UNIT * BP * BP <=
            mid * qty * (BP - SPREAD_BP) * (BP - FEE_BP),
          context,
        );
        holds(price * BP <= mid * (BP - SPREAD_BP), context);
        holds(usd * COIN_UNIT <= price * qty, context);
      }
      holds(fee * BP >= usd * FEE_BP, context);
    }
  });

  it('rounds by less than a cent each time: the house takes the rounding, nothing more', () => {
    for (const { mid, qty, side } of cases(20_000)) {
      const { price, usdAmount: usd, fee } = quoteAmounts(mid, side, qty);
      const exactUsd = price * qty; // in cents · 10^8
      const exactFee = usd * FEE_BP; // in cents · 10^4
      const context = `${side} ${qty} at mid ${mid}`;
      holds(
        (usd * COIN_UNIT - exactUsd) * (side === 'BUY' ? 1n : -1n) < COIN_UNIT,
        context,
      );
      holds(fee * BP - exactFee < BP, context);
      const exactPrice =
        mid * (side === 'BUY' ? BP + SPREAD_BP : BP - SPREAD_BP);
      holds(
        (price * BP - exactPrice) * (side === 'BUY' ? 1n : -1n) < BP,
        context,
      );
    }
  });
});

describe('pricing examples', () => {
  it('quotes a buy of 2 NXC at a $42.00 mid', () => {
    expect(quoteAmounts(4_200n, 'BUY', 2n * COIN_UNIT)).toEqual({
      price: 4_209n, // 4,200 · 1.002 = 4,208.4 → up
      usdAmount: 8_418n,
      fee: 43n, // 42.09 → up
      total: 8_461n,
    });
  });

  it('quotes a sell of 2 NXC at a $42.00 mid', () => {
    expect(quoteAmounts(4_200n, 'SELL', 2n * COIN_UNIT)).toEqual({
      price: 4_191n, // 4,191.6 → down
      usdAmount: 8_382n,
      fee: 42n, // 41.91 → up
      total: 8_340n,
    });
  });

  it('rounds a fraction of a cent up for a buyer and down for a seller', () => {
    // 0.5 coin at $0.03: exactly 1.5 cents.
    expect(usdAmount(3n, COIN_UNIT / 2n, 'BUY')).toBe(2n);
    expect(usdAmount(3n, COIN_UNIT / 2n, 'SELL')).toBe(1n);
    expect(usdAmount(3n, 1n, 'SELL')).toBe(0n);
  });

  it('charges at least a cent of fee on any non-zero amount', () => {
    expect(feeFor(0n)).toBe(0n);
    expect(feeFor(1n)).toBe(1n);
    expect(feeFor(200n)).toBe(1n);
    expect(feeFor(201n)).toBe(2n);
  });

  it('spreads the price both ways', () => {
    expect(quotePrice(10_000n, 'BUY')).toBe(10_020n);
    expect(quotePrice(10_000n, 'SELL')).toBe(9_980n);
    expect(quotePrice(1n, 'SELL')).toBe(0n);
  });
});

describe('limit orders', () => {
  it('trade at the limit price, with the quote rounding and fee, and a buy holds exactly its cost', () => {
    for (const { mid: limit, qty, side } of cases(5_000)) {
      const terms = limitAmounts(limit, side, qty);
      const context = `${side} ${qty} at limit ${limit}`;
      holds(terms.price === limit, context);
      holds(terms.usdAmount === usdAmount(limit, qty, side), context);
      holds(terms.fee === feeFor(terms.usdAmount), context);
      const hold = holdFor('NXC', side, qty, terms);
      // What the hold covers is what settling takes from it: nothing comes back for a buy.
      holds(
        side === 'BUY'
          ? hold.asset === 'USD' && hold.amount === terms.total
          : hold.asset === 'NXC' && hold.amount === qty,
        context,
      );
    }
  });

  it("holds the spec's qty · limit · 1.005 for a buy of 2 coins at $40.00", () => {
    const terms = limitAmounts(4_000n, 'BUY', 2n * COIN_UNIT);
    expect(terms).toEqual({
      price: 4_000n,
      usdAmount: 8_000n,
      fee: 40n,
      total: 8_040n,
    });
    expect(holdFor('NXC', 'BUY', 2n * COIN_UNIT, terms)).toEqual({
      asset: 'USD',
      amount: 8_040n,
    });
    expect(holdFor('ORB', 'SELL', 3n, terms)).toEqual({
      asset: 'ORB',
      amount: 3n,
    });
  });
});
