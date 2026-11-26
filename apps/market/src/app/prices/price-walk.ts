import { CoinCode } from '@jobber/money';
import {
  SIMULATED_COINS,
  SimulatedCoin,
  SimulatedSource,
  simulated,
} from './coins';
import { Random, gaussian, mulberry32, seedFor } from './random';

/** One step of the walk is one second of market time; `mu` and `sigma` are per day. */
const DT = 1 / 86_400;

/** The walk never goes below one cent, the smallest price it can publish. */
const MIN_PRICE = 1;

export interface Step {
  /** USD cents per coin, unrounded. */
  mid: number;
  /** The news shock applied in this step (e.g. -0.08), or 0. */
  shock: number;
}

/**
 * Geometric Brownian motion, one step per second:
 * `p' = p · exp((μ − σ²/2)·Δt + σ·√Δt·Z)`, plus now and then a news shock of ±5–15%.
 */
export class PriceWalk {
  private readonly drift: number;
  private readonly vol: number;
  private readonly shockPerStep: number;

  constructor(
    private mid: number,
    spec: Pick<SimulatedSource, 'mu' | 'sigma' | 'shockChance'>,
    private readonly random: Random,
  ) {
    this.drift = (spec.mu - (spec.sigma * spec.sigma) / 2) * DT;
    this.vol = spec.sigma * Math.sqrt(DT);
    this.shockPerStep = spec.shockChance / 60;
  }

  get current(): number {
    return this.mid;
  }

  /** Continue from another price (the last one a previous leader published). */
  moveTo(mid: number): void {
    this.mid = Math.max(mid, MIN_PRICE);
  }

  step(): Step {
    let next =
      this.mid * Math.exp(this.drift + this.vol * gaussian(this.random));
    let shock = 0;
    if (this.random() < this.shockPerStep) {
      const size = 0.05 + 0.1 * this.random();
      shock = this.random() < 0.5 ? -size : size;
      next *= 1 + shock;
    }
    this.mid = Math.max(next, MIN_PRICE);
    return { mid: this.mid, shock };
  }
}

/** The published price: whole USD cents per coin, at least 1. */
export function toCents(mid: number): bigint {
  return BigInt(Math.max(MIN_PRICE, Math.round(mid)));
}

export interface Tick {
  coin: CoinCode;
  /** Whole cents: what quotes and clients see. */
  price: bigint;
  /** The walk's exact value, kept so the next leader continues without rounding drift. */
  mid: number;
  shock: number;
}

/**
 * Every simulated coin's walk (the live coins follow the exchanges instead). Each coin draws from
 * its own seeded stream, so a given seed produces the same ticks every run.
 */
export class PriceSimulator {
  private readonly walks: Map<CoinCode, PriceWalk>;

  constructor(
    readonly seed: number,
    sourceOf: (coin: SimulatedCoin) => SimulatedSource = simulated,
  ) {
    this.walks = new Map(
      SIMULATED_COINS.map((coin) => [
        coin,
        new PriceWalk(
          sourceOf(coin).initialPrice,
          sourceOf(coin),
          mulberry32(seedFor(seed, coin)),
        ),
      ]),
    );
  }

  /** Moves the given coins to these prices; the random streams carry on where they were. */
  resume(mids: Partial<Record<CoinCode, number>>): void {
    for (const [coin, mid] of Object.entries(mids)) {
      this.walks.get(coin as CoinCode)?.moveTo(mid);
    }
  }

  /** One second: one tick per simulated coin, in `COINS` order. */
  next(): Tick[] {
    return [...this.walks].map(([coin, walk]) => {
      const { mid, shock } = walk.step();
      return { coin, price: toCents(mid), mid, shock };
    });
  }
}
