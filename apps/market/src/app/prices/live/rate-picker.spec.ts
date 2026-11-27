import { LiveCoin } from '../coins';
import { ProviderName } from '../providers/price-provider';
import { PickerEvent, RatePicker } from './rate-picker';

// The picker with a hand-driven clock: each `second()` is one tick of the leader.

const S = 1_000;

function setup(coins: LiveCoin[] = ['BTC', 'ETH']) {
  const events: PickerEvent[] = [];
  const picker = new RatePicker(
    coins,
    { providers: ['coinbase', 'binance'] },
    (e) => events.push(e),
  );
  let now = 0;
  const alive: Record<ProviderName, boolean> = {
    coinbase: true,
    binance: true,
  };
  const prices: Record<string, number> = {};
  const silent = new Set<string>();

  /** Both providers report every coin (unless silent or down), then the leader picks. */
  const second = () => {
    now += S;
    for (const provider of ['coinbase', 'binance'] as const) {
      if (!alive[provider]) continue;
      for (const coin of coins) {
        if (silent.has(`${provider}:${coin}`)) continue;
        const price = prices[`${provider}:${coin}`] ?? prices[coin];
        if (price !== undefined) picker.observe(provider, coin, price, now);
      }
    }
    return picker.pick(now, (p) => alive[p]);
  };
  const seconds = (n: number) => {
    let last = second();
    for (let i = 1; i < n; i++) last = second();
    return last;
  };
  const sourceOf = (picks: ReturnType<typeof second>, coin: LiveCoin) =>
    picks.find((p) => p.coin === coin)?.source ?? null;
  const switches = () => events.filter((e) => e.type === 'switch');
  return {
    picker,
    events,
    alive,
    prices,
    silent,
    second,
    seconds,
    sourceOf,
    switches,
    at: () => now,
  };
}

describe('RatePicker', () => {
  it('prices every coin from the preferred provider', () => {
    const t = setup();
    t.prices['BTC'] = 6_000_000;
    t.prices['ETH'] = 300_000;

    expect(t.second()).toEqual([
      { coin: 'BTC', price: 6_000_000, source: 'coinbase' },
      { coin: 'ETH', price: 300_000, source: 'coinbase' },
    ]);
  });

  it("fails a silent coin over to the next provider, alone, once it's stale (test 2)", () => {
    const t = setup();
    t.prices['BTC'] = 6_000_000;
    t.prices['ETH'] = 300_000;
    t.seconds(3);
    t.silent.add('coinbase:BTC');

    // Coinbase's last BTC price stays usable for 10 s…
    for (let i = 1; i <= 10; i++) {
      expect(t.sourceOf(t.second(), 'BTC')).toBe('coinbase');
    }
    // … then BTC moves to Binance, and ETH stays.
    const picks = t.second();
    expect(t.sourceOf(picks, 'BTC')).toBe('binance');
    expect(t.sourceOf(picks, 'ETH')).toBe('coinbase');
    expect(t.switches()).toContainEqual({
      type: 'switch',
      coin: 'BTC',
      from: 'coinbase',
      to: 'binance',
      reason: 'coinbase is silent for BTC',
    });
  });

  it('heartbeats keep a quiet coin fresh: no trade for a minute is not a failure', () => {
    const t = setup(['BTC']);
    t.prices['BTC'] = 6_000_000;
    t.second();
    t.silent.add('coinbase:BTC');

    for (let i = 0; i < 60; i++) {
      t.picker.heartbeat('coinbase', 'BTC', t.at() + S);
      expect(t.sourceOf(t.second(), 'BTC')).toBe('coinbase');
    }
  });

  it('fails every coin over at once when the connection is down (test 3)', () => {
    const t = setup();
    t.prices['BTC'] = 6_000_000;
    t.prices['ETH'] = 300_000;
    t.seconds(3);

    t.alive.coinbase = false;
    const picks = t.second();

    expect(picks.map((p) => p.source)).toEqual(['binance', 'binance']);
    expect(t.switches().at(-1)).toMatchObject({
      reason: 'coinbase is disconnected',
    });
  });

  it('fails back after 30 s of steady health, and a flapping connection never switches (test 4)', () => {
    const t = setup(['BTC']);
    t.prices['BTC'] = 6_000_000;
    t.seconds(3);
    t.alive.coinbase = false;
    expect(t.sourceOf(t.second(), 'BTC')).toBe('binance');

    // Flapping: up 10 s, down 2 s, up 10 s, down 2 s.
    for (let flap = 0; flap < 2; flap++) {
      t.alive.coinbase = true;
      for (let i = 0; i < 10; i++) {
        expect(t.sourceOf(t.second(), 'BTC')).toBe('binance');
      }
      t.alive.coinbase = false;
      t.seconds(2);
    }

    // Steady: back on Coinbase on the 30th second of health, not before.
    t.alive.coinbase = true;
    for (let i = 1; i <= 30; i++) {
      expect(t.sourceOf(t.second(), 'BTC')).toBe('binance');
    }
    expect(t.sourceOf(t.second(), 'BTC')).toBe('coinbase');
    expect(t.switches().map((s) => s.to)).toEqual([
      'coinbase',
      'binance',
      'coinbase',
    ]);
  });

  it('gives a coin to the preferred provider at once when it connects later than the other', () => {
    const t = setup(['BTC']);
    t.prices['BTC'] = 6_000_000;
    t.alive.coinbase = false; // still connecting
    expect(t.sourceOf(t.second(), 'BTC')).toBe('binance');

    t.alive.coinbase = true;
    expect(t.sourceOf(t.second(), 'BTC')).toBe('coinbase');
  });

  it('prices nothing when nobody is healthy, and resumes when someone is (test 5)', () => {
    const t = setup(['BTC']);
    t.prices['BTC'] = 6_000_000;
    t.seconds(2);
    t.alive.coinbase = false;
    t.alive.binance = false;

    expect(t.second()).toEqual([]);
    expect(t.events).toContainEqual({
      type: 'unavailable',
      coin: 'BTC',
      from: 'coinbase',
    });
    expect(t.seconds(30)).toEqual([]);

    t.alive.binance = true;
    expect(t.second()).toEqual([
      { coin: 'BTC', price: 6_000_000, source: 'binance' },
    ]);
  });

  it('never publishes a single bad print; a move confirmed by both is published (test 6)', () => {
    const t = setup(['BTC']);
    t.prices['BTC'] = 6_000_000;
    t.seconds(3);

    // One Coinbase message 20% off, then back to normal.
    t.prices['coinbase:BTC'] = 4_800_000;
    expect(t.second()).toEqual([
      { coin: 'BTC', price: 6_000_000, source: 'coinbase' },
    ]);
    delete t.prices['coinbase:BTC'];
    expect(t.seconds(5).map((p) => p.price)).toEqual([6_000_000]);
    expect(t.events).toContainEqual({
      type: 'held',
      coin: 'BTC',
      provider: 'coinbase',
      price: 4_800_000,
      reference: 6_000_000,
    });

    // A real 12% move: Coinbase then Binance in the same second.
    t.prices['BTC'] = 6_720_000;
    expect(t.second()).toEqual([
      { coin: 'BTC', price: 6_720_000, source: 'coinbase' },
    ]);
    expect(t.events.at(-1)).toMatchObject({
      type: 'confirmed',
      by: 'coinbase',
    });
  });

  it('a jump the same provider repeats within 5 s is confirmed by it alone', () => {
    const t = setup(['BTC']);
    t.prices['BTC'] = 6_000_000;
    t.seconds(2);
    t.alive.binance = false;
    t.prices['BTC'] = 6_720_000;

    // First print held (the previous price stands), the repeat a second later confirms it.
    expect(t.second()[0].price).toBe(6_000_000);
    expect(t.second()[0].price).toBe(6_720_000);
  });

  it("a print that isn't repeated within 5 s stays held, and the coin goes stale", () => {
    const t = setup(['BTC']);
    t.prices['BTC'] = 6_000_000;
    t.seconds(2);
    t.alive.binance = false;
    // Every 6 s a different wild print, nothing else.
    t.silent.add('coinbase:BTC');
    const wild = [4_000_000, 8_000_000, 4_100_000];
    const seen: number[][] = [];
    for (const price of wild) {
      t.picker.observe('coinbase', 'BTC', price, t.at() + 1);
      seen.push(t.seconds(6).map((p) => p.price));
    }
    expect(seen.flat().every((p) => p === 6_000_000)).toBe(true);
    // Held prints don't keep the old price fresh: 10 s after the last good one, no price.
    expect(t.second()).toEqual([]);
  });

  it('logs a divergence over 1% once, and when it ends', () => {
    const t = setup(['ETH']);
    t.prices['ETH'] = 300_000;
    t.seconds(2);
    t.prices['binance:ETH'] = 304_000; // 1.3% above
    t.seconds(5);
    t.prices['binance:ETH'] = 300_100;
    t.seconds(2);

    expect(
      t.events.filter((e) => e.type === 'diverging' || e.type === 'converged'),
    ).toEqual([
      {
        type: 'diverging',
        coin: 'ETH',
        prices: { coinbase: 300_000, binance: 304_000 },
      },
      { type: 'converged', coin: 'ETH' },
    ]);
  });

  it('checks the first prices against the previous leader’s, when given', () => {
    const t = setup(['BTC']);
    t.picker.setReference('BTC', 6_000_000);
    t.alive.binance = false;
    t.prices['BTC'] = 3_000_000;

    expect(t.second()).toEqual([]); // held, and nothing older to publish
    expect(t.second()).toEqual([
      { coin: 'BTC', price: 3_000_000, source: 'coinbase' },
    ]);
  });
});
