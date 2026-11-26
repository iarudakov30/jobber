# Step 1 — Contracts

- **Where:** committed directly to `main`.

## Why

Before anything talks to an exchange, the rest of the system has to know the real coins exist
and has to stop assuming that every coin walks:

- **the wallet** must accept BTC, ETH, HYPE and ZEC as assets, or no account can hold them;
- **the market** must know, per coin, whether the simulator or an exchange prices it. The
  simulator must leave the real coins alone, and the history generator must not invent their past;
- **every consumer of a price** (quotes, the gateway, the React app) needs to see where it came
  from, to show "Coinbase" or "Binance · fallback" later.

## What changed

| Area            | Change                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/money`    | `ASSETS` gains BTC, ETH, HYPE, ZEC (scale 8, `kind: 'coin'`); `COINS` now lists eight                                                                                                                           |
| `apps/wallet`   | Migration `0006_live_coin_assets.sql` seeds the four assets (the existing test compares the table with `ASSETS`)                                                                                                |
| `apps/market`   | `prices/coins.ts`: each coin has a `source`, `simulated` (walk parameters) or `live` (its Coinbase and Binance pairs); `SIMULATED_COINS`, `LIVE_COINS`, `isSimulated`, `isLive`, `simulated()`, `liveSymbols()` |
| `apps/market`   | The simulator walks only the simulated coins; `generateDay` and `GenerateCandles` only generate simulated coins' history                                                                                        |
| `libs/rabbitmq` | `RealtimePriceMessage.source`: `simulator`, `coinbase` or `binance` (`PRICE_TICK_SOURCES`)                                                                                                                      |
| `apps/market`   | Redis `price:<coin>` keeps `source`; GraphQL `PriceTick.source` and `Coin.live`; `schema.gql` updated                                                                                                           |

## How it works

### One list of coins, two kinds

`libs/money` stays about amounts: it knows eight coins with eight decimals each, and nothing about
prices. Eight decimals are Bitcoin's own and more than enough for paper ETH, so `COIN_UNIT`, the
pricing and its rounding rules apply unchanged.

Where a price comes from is the market's business (`prices/coins.ts`):

```ts
BTC: { name: 'Bitcoin', source: { kind: 'live', symbols: { coinbase: 'BTC-USD', binance: 'BTCUSDT' } } }
NXC: { name: 'Nexus Coin', source: { kind: 'simulated', initialPrice: 4_200, mu: 0.01, sigma: 0.08, shockChance: 0.002 } }
```

The spec is `as const`, so `SimulatedCoin` and `LiveCoin` are derived types: the compiler stops
anything from asking for a live coin's volatility. `PriceSimulator` builds walks for
`SIMULATED_COINS` only, with each coin's seeded stream as before, so the same seed still gives
the same ticks (phase 4's test 1 passes unchanged).

### `source` on every tick

```json
{ "type": "price", "coin": "NXC", "price": "4103", "seq": 2011, "at": 1764170000000, "source": "simulator" }
```

The Lua script that bumps `seq` also stores `source` in `price:<coin>`. A price stored before this
step has none and reads as `simulator`, which is where it came from. GraphQL shows it on
`PriceTick.source`, and `Coin.live` tells the two kinds apart. The gateway forwards message bodies
as they are, so browsers get `source` without a gateway change.

### Until the providers exist

Steps 2 and 3 add the exchange providers. Until then:

- `coins` lists the four real coins with `tick: null`, and `quote` for them answers
  `PRICES_UNAVAILABLE`, as for any coin without a recent price;
- `GenerateCandles` refuses a live coin with `INVALID_ARGUMENT` ("BTC is priced by the exchanges:
  its history isn't generated"). Step 4 replaces that with real candles. A `BackfillCandles`
  range now covers all eight coins by default, so until step 4 the live coins' items are
  dead-lettered; name `coins` in the range to avoid it.

## How it was verified

- `npx nx test money`: `COINS` lists the eight in order, all with scale 8.
- `npx nx test wallet`: the assets table equals `ASSETS` after the new migration (104 tests).
- `npx nx test market` (95 tests):
  - the simulator ticks only the simulated coins, in `COINS` order; same seed, same ticks;
  - price messages carry `source: 'simulator'`, and so does every price in Redis;
  - `coins` lists all eight with their names, `live` true for the real four, which have no tick;
  - `GenerateCandles` refuses BTC with `INVALID_ARGUMENT`;
  - the schema test was checked to fail on the old `schema.gql`, and passes on the new one.
- `npx nx test realtime`: the public channels are now the eight `prices.<coin>`.
- `npx nx test jobs`: a `BackfillCandles` range defaults to the eight coins.
- `npx nx affected -t lint build typecheck`: green for 11 projects; `npx nx affected -t test`:
  green for 10 (run one project at a time). `nexus:codegen` regenerated with no difference.

## Lessons

- **Kinds belong where they are used.** Putting "simulated or live" into `libs/money` would have
  been one line, but the wallet, the gateway and the React app have no use for it, and every
  library user would have learned about the market's providers. `libs/money` lists coins;
  `apps/market` knows how each is priced.
- **Don't run Testcontainers suites next to the whole running app.** With `npm start` and every
  compose container up, parallel test runs ran Jest out of memory and took Docker Desktop down
  with them. Tests ran one project at a time once the app was stopped.
