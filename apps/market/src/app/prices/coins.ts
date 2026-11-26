import { COINS, CoinCode } from '@jobber/money';

/** A coin priced by the seeded random walk (`PriceSimulator`). */
export interface SimulatedSource {
  kind: 'simulated';
  /** Where the walk starts when Redis has no price yet: USD cents per whole coin. */
  initialPrice: number;
  /** Drift per day: 0.01 is +1% a day on average. */
  mu: number;
  /** Volatility per day: 0.1 moves the price about 10% in a day. */
  sigma: number;
  /** Chance of a news shock (±5–15%) in any one minute. */
  shockChance: number;
}

/** A coin priced from public exchange data (phase 4.5): its pair on each provider. */
export interface LiveSource {
  kind: 'live';
  symbols: {
    /** Coinbase Exchange product, quoted in USD: `BTC-USD`. */
    coinbase: string;
    /** Binance symbol, quoted in USDT (the fallback): `BTCUSDT`. */
    binance: string;
  };
}

export type PriceSource = SimulatedSource | LiveSource;

export interface CoinSpec {
  name: string;
  source: PriceSource;
}

const live = (base: string): LiveSource => ({
  kind: 'live',
  symbols: { coinbase: `${base}-USD`, binance: `${base}USDT` },
});

/**
 * Every coin and where its price comes from.
 *
 * - The invented coins walk. Their volatility is far above any real asset's, so the charts move
 *   while someone is watching; that is the point of a demo market.
 * - The real coins follow the exchanges (Coinbase, Binance as the fallback). They are traded with
 *   paper money against the same simulated market maker.
 */
export const COIN_SPECS = {
  NXC: {
    name: 'Nexus Coin',
    source: {
      kind: 'simulated',
      initialPrice: 4_200,
      mu: 0.01,
      sigma: 0.08,
      shockChance: 0.002,
    },
  },
  BLIP: {
    name: 'Blip',
    source: {
      kind: 'simulated',
      initialPrice: 1_250,
      mu: 0,
      sigma: 0.15,
      shockChance: 0.004,
    },
  },
  ORB: {
    name: 'Orb',
    source: {
      kind: 'simulated',
      initialPrice: 31_000,
      mu: 0.005,
      sigma: 0.05,
      shockChance: 0.001,
    },
  },
  WISP: {
    name: 'Wisp',
    source: {
      kind: 'simulated',
      initialPrice: 340,
      mu: -0.01,
      sigma: 0.25,
      shockChance: 0.006,
    },
  },
  BTC: { name: 'Bitcoin', source: live('BTC') },
  ETH: { name: 'Ethereum', source: live('ETH') },
  HYPE: { name: 'Hyperliquid', source: live('HYPE') },
  ZEC: { name: 'Zcash', source: live('ZEC') },
} as const satisfies Record<CoinCode, CoinSpec>;

export type SimulatedCoin = {
  [K in CoinCode]: (typeof COIN_SPECS)[K]['source']['kind'] extends 'simulated'
    ? K
    : never;
}[CoinCode];
export type LiveCoin = Exclude<CoinCode, SimulatedCoin>;

export function isSimulated(coin: CoinCode): coin is SimulatedCoin {
  return COIN_SPECS[coin].source.kind === 'simulated';
}

export function isLive(coin: CoinCode): coin is LiveCoin {
  return COIN_SPECS[coin].source.kind === 'live';
}

/** The walking coins, in `COINS` order. */
export const SIMULATED_COINS: SimulatedCoin[] = COINS.filter(isSimulated);
/** The exchange-priced coins, in `COINS` order. */
export const LIVE_COINS: LiveCoin[] = COINS.filter(isLive);

/** A walking coin's parameters. */
export function simulated(coin: SimulatedCoin): SimulatedSource {
  return COIN_SPECS[coin].source;
}

/** An exchange-priced coin's pairs. */
export function liveSymbols(coin: LiveCoin): LiveSource['symbols'] {
  return COIN_SPECS[coin].source.symbols;
}
