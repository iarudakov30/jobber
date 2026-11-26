import { SIMULATED_COINS, simulated } from './coins';
import { PriceSimulator, PriceWalk, toCents } from './price-walk';
import { gaussian, mulberry32, seedFor } from './random';

function run(seed: number, ticks: number) {
  const simulator = new PriceSimulator(seed);
  return Array.from({ length: ticks }, () => simulator.next());
}

describe('PriceSimulator', () => {
  // Acceptance test 1.
  it('produces identical first 1,000 ticks from the same seed', () => {
    const first = run(42, 1_000);
    const second = run(42, 1_000);
    expect(second).toEqual(first);
    // Not trivially equal: the prices actually move.
    const nxc = first.map((ticks) => ticks[0].mid);
    expect(new Set(nxc).size).toBe(1_000);
  });

  it('produces different ticks from a different seed', () => {
    expect(run(43, 10)).not.toEqual(run(42, 10));
  });

  it('ticks every simulated coin once, in COINS order', () => {
    const [ticks] = run(1, 1);
    expect(ticks.map((t) => t.coin)).toEqual(SIMULATED_COINS);
    for (const tick of ticks) {
      expect(tick.price).toBe(toCents(tick.mid));
    }
  });

  it("gives each coin its own stream: one coin's ticks don't depend on the others", () => {
    const alone = new PriceWalk(
      simulated('ORB').initialPrice,
      simulated('ORB'),
      mulberry32(seedFor(7, 'ORB')),
    );
    const expected = Array.from({ length: 100 }, () => alone.step().mid);
    const all = run(7, 100).map((ticks) => ticks[2]);
    expect(all.map((t) => t.coin)).toEqual(Array(100).fill('ORB'));
    expect(all.map((t) => t.mid)).toEqual(expected);
  });

  it('continues from resumed prices with the random streams where they were', () => {
    const simulator = new PriceSimulator(5);
    simulator.next();
    simulator.resume({ NXC: 10_000 });
    const [nxc, blip] = simulator.next();
    expect(nxc.mid).toBeGreaterThan(9_000);
    expect(nxc.mid).toBeLessThan(11_000);
    // BLIP wasn't resumed: it carries on from its own price.
    expect(blip.mid).toBeLessThan(2_000);
  });

  it('starts every coin at its configured price', () => {
    const [ticks] = run(9, 1);
    for (const tick of ticks) {
      const start = simulated(tick.coin as 'NXC').initialPrice;
      // One second of a walk moves the price by a fraction of a percent, unless a shock hit.
      if (tick.shock === 0) {
        expect(Math.abs(tick.mid / start - 1)).toBeLessThan(0.01);
      }
    }
  });
});

describe('PriceWalk', () => {
  const calm = { mu: 0, sigma: 0.1, shockChance: 0 };

  it('has the configured volatility', () => {
    // σ = 0.1 per day: log returns over 86,400 one-second steps have a standard deviation of 0.1.
    const walk = new PriceWalk(10_000, calm, mulberry32(3));
    const returns: number[] = [];
    let previous = walk.current;
    for (let i = 0; i < 86_400; i++) {
      const { mid } = walk.step();
      returns.push(Math.log(mid / previous));
      previous = mid;
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const dailySigma = Math.sqrt(variance * 86_400);
    expect(dailySigma).toBeGreaterThan(0.098);
    expect(dailySigma).toBeLessThan(0.102);
  });

  it('applies news shocks of 5% to 15% at the configured rate', () => {
    // A shock every minute on average: about 1,000 in 60,000 steps.
    const walk = new PriceWalk(
      10_000,
      { mu: 0, sigma: 0, shockChance: 1 },
      mulberry32(11),
    );
    const shocks: number[] = [];
    for (let i = 0; i < 60_000; i++) {
      const { shock } = walk.step();
      if (shock !== 0) {
        shocks.push(shock);
        walk.moveTo(10_000); // keep it away from the floor
      }
    }
    expect(shocks.length).toBeGreaterThan(900);
    expect(shocks.length).toBeLessThan(1_100);
    for (const shock of shocks) {
      expect(Math.abs(shock)).toBeGreaterThanOrEqual(0.05);
      expect(Math.abs(shock)).toBeLessThan(0.15);
    }
    const down = shocks.filter((s) => s < 0).length;
    expect(down / shocks.length).toBeGreaterThan(0.4);
    expect(down / shocks.length).toBeLessThan(0.6);
  });

  it('never goes below one cent', () => {
    const walk = new PriceWalk(
      2,
      { mu: -50, sigma: 2, shockChance: 0 },
      mulberry32(1),
    );
    for (let i = 0; i < 10_000; i++) {
      expect(walk.step().mid).toBeGreaterThanOrEqual(1);
    }
    expect(toCents(walk.current)).toBe(1n);
  });
});

describe('random', () => {
  it('mulberry32 yields numbers in [0, 1) and repeats for a seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 1_000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('gaussian has mean 0 and variance 1', () => {
    const random = mulberry32(99);
    const draws = Array.from({ length: 100_000 }, () => gaussian(random));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const variance =
      draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(variance - 1)).toBeLessThan(0.02);
  });

  it('seedFor separates labels and seeds', () => {
    expect(seedFor(1, 'NXC')).not.toBe(seedFor(1, 'BLIP'));
    expect(seedFor(1, 'NXC')).not.toBe(seedFor(2, 'NXC'));
    expect(seedFor(1, 'NXC')).toBe(seedFor(1, 'NXC'));
  });
});
