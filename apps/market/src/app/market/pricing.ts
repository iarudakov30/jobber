import { ASSETS } from '@jobber/money';

export const TRADE_SIDES = ['BUY', 'SELL'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

/** Minor units in one whole coin (every coin has scale 8). */
export const COIN_UNIT = 10n ** BigInt(ASSETS.NXC.scale);

const BASIS_POINTS = 10_000n;
/** A quote is 0.2% worse than the mid price: buyers pay above it, sellers get below it. */
export const SPREAD_BP = 20n;
/** 0.5% of the USD amount, on every trade. */
export const FEE_BP = 50n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** USD cents per coin a quote offers: the mid plus the spread for a buy, minus it for a sell. */
export function quotePrice(mid: bigint, side: TradeSide): bigint {
  return side === 'BUY'
    ? ceilDiv(mid * (BASIS_POINTS + SPREAD_BP), BASIS_POINTS)
    : (mid * (BASIS_POINTS - SPREAD_BP)) / BASIS_POINTS;
}

/**
 * `price · qty / 10^8` in whole cents: a buyer's cost rounds up, a seller's proceeds round
 * down. Rounding never costs the market maker.
 */
export function usdAmount(price: bigint, qty: bigint, side: TradeSide): bigint {
  return side === 'BUY'
    ? ceilDiv(price * qty, COIN_UNIT)
    : (price * qty) / COIN_UNIT;
}

/** 0.5% of the USD amount, rounded up whichever way the trade goes. */
export function feeFor(usd: bigint): bigint {
  return ceilDiv(usd * FEE_BP, BASIS_POINTS);
}

export interface TradeAmounts {
  /** USD cents per coin. */
  price: bigint;
  /** USD cents for `qty`, before the fee. */
  usdAmount: bigint;
  fee: bigint;
  /** What the user pays (buy: usdAmount + fee) or receives (sell: usdAmount − fee). */
  total: bigint;
}

/** Everything a quote states, from the mid price. Amounts may be 0 for a tiny `qty`. */
export function quoteAmounts(
  mid: bigint,
  side: TradeSide,
  qty: bigint,
): TradeAmounts {
  const price = quotePrice(mid, side);
  const usd = usdAmount(price, qty, side);
  const fee = feeFor(usd);
  return {
    price,
    usdAmount: usd,
    fee,
    total: side === 'BUY' ? usd + fee : usd - fee,
  };
}
