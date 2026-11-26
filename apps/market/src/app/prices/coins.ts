import { CoinCode } from '@jobber/money';

export interface CoinSpec {
  name: string;
  /** Where the walk starts when Redis has no price yet: USD cents per whole coin. */
  initialPrice: number;
  /** Drift per day: 0.01 is +1% a day on average. */
  mu: number;
  /** Volatility per day: 0.1 moves the price about 10% in a day. */
  sigma: number;
  /** Chance of a news shock (±5–15%) in any one minute. */
  shockChance: number;
}

/**
 * The invented coins. Volatility is far above any real asset's, so the charts move while
 * someone is watching; that is the point of a demo market.
 */
export const COIN_SPECS: Record<CoinCode, CoinSpec> = {
  NXC: {
    name: 'Nexus Coin',
    initialPrice: 4_200,
    mu: 0.01,
    sigma: 0.08,
    shockChance: 0.002,
  },
  BLIP: {
    name: 'Blip',
    initialPrice: 1_250,
    mu: 0,
    sigma: 0.15,
    shockChance: 0.004,
  },
  ORB: {
    name: 'Orb',
    initialPrice: 31_000,
    mu: 0.005,
    sigma: 0.05,
    shockChance: 0.001,
  },
  WISP: {
    name: 'Wisp',
    initialPrice: 340,
    mu: -0.01,
    sigma: 0.25,
    shockChance: 0.006,
  },
};
