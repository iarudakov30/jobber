# Step 3 — Rate provider and live ticks

- **Where:** committed directly to `main`.

## Why

Step 2 gave each exchange an adapter. This step turns two adapters into one price per coin and
publishes it like any simulated price:

- **failover per coin:** one halted pair moves to Binance, the other coins stay on Coinbase; a
  Coinbase outage moves all of them;
- **failback without flapping:** back to Coinbase only once it has been steadily healthy;
- **no price rather than a wrong one:** with nobody healthy a coin stops ticking, and one bad
  message from an exchange is never published or traded on;
- **the same path as the simulator:** Redis `price:<coin>` with its `seq`, RabbitMQ
  `prices.<coin>`, 1-minute candles, and the limit order matcher.

## What changed

| Area                                             | Change                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prices/live/rate-picker.ts`                     | `RatePicker`: health per provider and coin, failover, failback, bad print guard, divergence; pure (given the time and which connections are up)        |
| `prices/live/live-prices.ts`                     | `LivePrices`: builds the providers from config, connects them while leading, feeds the picker; `livePricesOptionsFromEnv`                              |
| `prices/price-ticker.ts`, `simulator.service.ts` | Each tick adds the live coins' picks after the simulated coins; the leader connects the providers when it starts leading and disconnects when it stops |
| `prices/providers/*`                             | `connect(coins, onPrice, onHeartbeat)`: Coinbase reports its per-product heartbeats                                                                    |
| `apps/market/.env`                               | `MARKET_LIVE_PRICES=on`, `MARKET_PRICE_PROVIDERS=binance,coinbase`, the four endpoint URLs (commented, defaults)                                       |
| `live-prices.api.spec.ts`, `rate-picker.spec.ts` | Acceptance tests 2–6 end to end against the fake exchanges; the picker's rules with a hand-driven clock                                                |

## How it works

### One price per coin, once a second

The leader keeps both providers connected while it leads (hot standby: a failover costs no
reconnect). Every price and heartbeat goes into the `RatePicker` with the local time it arrived.
Once a second, the ticker asks the picker for each live coin's price and publishes it next to
the simulated ones:

```json
{ "type": "price", "coin": "BTC", "price": "6000000", "seq": 6, "at": 1795796515109, "source": "binance" }
```

Exchange messages arriving faster (Coinbase sends a ticker per trade) only update the picker,
so the gateway still gets one message per coin per second. The price is rounded to cents once,
here; the unrounded value is kept as `mid` in Redis. A coin nobody prices gets no tick at all:
its `seq` stops, quotes refuse it after 10 s (`PRICES_UNAVAILABLE`, the existing rule) and the
matcher never sees a price for it.

### Health, failover, failback

| Rule       | Behaviour                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Healthy    | The provider's connection is alive (a message in the last 5 s) and its price for the coin is fresh: a price **or a heartbeat** for that coin in the last 10 s     |
| Preferred  | The first healthy provider in `MARKET_PRICE_PROVIDERS` order                                                                                                      |
| Failover   | The coin's provider isn't healthy: the next healthy one takes it at the next tick                                                                                 |
| Failback   | A more preferred provider that has failed must be healthy for 30 s in a row. One that has never been healthy for the coin yet (still connecting) takes it at once |
| Nobody     | No tick. Logged once ("no healthy provider, no price")                                                                                                            |
| Divergence | Both healthy and more than 1% apart: logged once, and once more when they agree again                                                                             |

Every switch is logged once with its reason, e.g. `BTC: coinbase → binance (coinbase is silent
for BTC)`.

**A deliberate change from the plan:** the plan had a coin's price stay usable for 60 s, because
Coinbase's ticker only speaks when a trade happens. Coinbase also sends a heartbeat per product
every second, and those now count: a quiet HYPE minute stays fresh through its heartbeats. That
allows a 10 s window, and 60 s would have been wrong in a way the plan missed: the leader
re-publishes the price every second with a fresh `at`, so a coin whose feed died would have been
quoted at a 60-second-old price. Now no price is older than 10 s, the same limit quotes already
apply.

### The bad print guard

A price more than 10% from the coin's last published price is held back. It goes through when:

- the same provider says it again (within 2%) within 5 s, or
- another provider says the same (its held price, or its current one within 5 s).

Until then that provider's previous price stands and ages. A one-off print is replaced by the
next normal price and is never published; a real move is confirmed within a second or two. A
provider that sends only wild prints goes stale after 10 s and loses the coin. On becoming
leader, the previous leader's live prices (if under a minute old) are the reference, so even
the first price after a handover is checked.

### Configuration

| Variable                                                                     | Default            |                                                               |
| ---------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `MARKET_LIVE_PRICES`                                                         | off when unset     | `on` in `apps/market/.env`; off, the live coins have no price |
| `MARKET_PRICE_PROVIDERS`                                                     | `binance,coinbase` | Order of preference; each at most once                        |
| `COINBASE_WS_URL`, `COINBASE_REST_URL`, `BINANCE_WS_URL`, `BINANCE_REST_URL` | the public ones    | Tests point them at the fake exchanges                        |

Unset means off (the plan had `on`) so that nothing, a test included, reaches the internet
unless it asks to; the committed `.env` turns it on for `npm start`. Only the simulator leader
connects: `MARKET_SIMULATOR=off` replicas never do.

**Binance first, also a change from the plan:** the plan preferred Coinbase. Its market data
terms turned out to be the stricter of the two (no valuations, no showing the data to anyone
else), so Binance prices the coins and Coinbase is the fallback; see
[02-providers.md, Terms of use](02-providers.md#terms-of-use). The tests below still run with
Coinbase first: the rules don't depend on which exchange is which.

## How it was verified

- `rate-picker.spec.ts` (12 tests, a hand-driven clock): a silent coin fails over alone after
  10 s and heartbeats keep a quiet one fresh for a minute; a dead connection moves every coin at
  the next tick; failback happens on the 30th second of steady health, never during "up 10 s,
  down 2 s" flapping; a late-connecting Coinbase takes over at once; no price with nobody
  healthy; a 20% print is never published, a 12% move confirmed by both is; a print not repeated
  within 5 s stays held and the coin goes stale; divergence logged once each way; the previous
  leader's price as the first reference.
- `live-prices.api.spec.ts` (6 tests, ~1 min): one replica of the real app against Testcontainers
  PostgreSQL, Redis and RabbitMQ, the fake exchanges and the fake wallet, with the windows
  shortened (stale 2 s, failback 4 s, alive 1 s):
  - the four live coins tick 2–4 times in 3.2 s from Coinbase, in cents, with the simulated ones
    still `simulator`; `coins` shows `live` and `source`;
  - **test 2:** BTC silenced on Coinbase moves to Binance within the stale window + 2.5 s, its
    `seq` strictly increasing and no gap over 2 s, the other three stay on Coinbase;
  - **test 3:** Coinbase dropped and refusing: all four on Binance within 5 s, no gap over 2 s;
  - **test 4:** after "up 2 s, down 1.5 s" twice nothing moved back; once steady, back on
    Coinbase after the failback window and not before;
  - **test 5:** both muted: the live coins stop ticking within the stale window (the simulated
    ones go on), a BTC limit buy above the last price stays `OPEN`, `quote` answers
    `PRICES_UNAVAILABLE` once the last price is 10 s old; prices back, the order fills;
  - **test 6:** a single Coinbase print 20% down is never on RabbitMQ and a limit buy at $53,000
    stays `OPEN`; a 12% fall on both exchanges is published within 2.5 s and fills it at its
    limit.
- `npx nx test market --runInBand`: 13 suites, 150 tests (phase 4's included, same seed, same
  ticks), with `MARKET_LIVE_PRICES` unset: nothing reaches the internet.
- `npx nx run-many -t lint build -p market` green (webpack compiled successfully).
- By hand against the real exchanges (the built bundle with `apps/market/.env`, ~30 s): both
  providers connected, the four coins `priced by coinbase` within a second of leading, no
  divergence warning; `coins` returned the four prices in cents with `source: coinbase`. After
  the switch to Binance first, the same run (~25 s): Coinbase happened to connect half a second
  earlier and priced the first second, then each coin moved `coinbase → binance (binance
  connected)` within 2 s and stayed there. Acceptance test
  1's comparison with the exchange's REST ticker is step 5's.

## Lessons

- **Re-publishing is republishing the age, too.** A price that is re-sent every second with a
  new timestamp looks fresh to everyone downstream. The window that decides whether a source
  still knows the price has to be no longer than what quotes accept.
- **Keep the decision pure.** The picker takes the time and the connections' state as arguments,
  so failover, failback and flapping were tested second by second in milliseconds; the
  end-to-end test then only has to show that the wiring carries those decisions.
