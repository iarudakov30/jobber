# Step 2 — Providers

- **Where:** committed directly to `main`.

## Why

Step 3 picks a price per coin from whichever exchange is healthy. Before it can, each exchange
needs an adapter that hides how that exchange speaks:

- a **live stream** that reports every price as `(coin, cents, time)`, keeps itself connected and
  says whether it is `alive`;
- **1-minute candles** over REST for step 4's history, already in cents and in the `candles`
  table's shape;
- and, for tests, **fake exchanges** that speak the same protocol on localhost and can be told to
  go quiet, drop connections, refuse them or answer REST with an error. Nothing in the test suite
  reaches the internet.

Nothing runs the providers yet: step 3 connects them on the simulator leader.

## What changed

| Area                                      | Change                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prices/providers/price-provider.ts`      | `PriceProvider` (`name`, `connect(coins, onPrice)`, `disconnect()`, `alive`, `candles(coin, from, to)`), `ProviderError` (with the HTTP status), `ProviderOptions` |
| `prices/providers/reconnecting-socket.ts` | A `ws` client that reconnects (1 s → 30 s, ×0.5–1 jitter), tracks `alive`, replaces a connection that has gone silent, and can reconnect at once                   |
| `prices/providers/coinbase.provider.ts`   | Coinbase Exchange: `ticker` + `heartbeat` subscription, `/products/{id}/candles` in windows of 300                                                                 |
| `prices/providers/binance.provider.ts`    | Binance: one combined `miniTicker` stream, `serverShutdown`, `/api/v3/klines` in pages of 1,000                                                                    |
| `prices/providers/cents.ts`, `http.ts`    | Decimal strings to cents without floating point; GET with a timeout; candle validation                                                                             |
| `src/testing/fake-exchanges.ts`           | `FakeCoinbase`, `FakeBinance`, `fakeDay()`                                                                                                                         |
| `src/testing/wait-for.ts`                 | `waitFor` and `sleep`, shared with `market.api.spec.ts`                                                                                                            |
| `apps/market/package.json`                | `ws` (it was only the gateway's)                                                                                                                                   |

## How it works

### The two exchanges

|                | Coinbase Exchange                                                                                                 | Binance                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Stream         | `wss://ws-feed.exchange.coinbase.com`, subscribe message                                                          | `wss://data-stream.binance.vision/stream?streams=btcusdt@miniTicker/…`                                                  |
| Price messages | `ticker` on every trade (and once after subscribing)                                                              | `24hrMiniTicker` every second: last price `c`, event time `E`                                                           |
| Keep-alive     | `heartbeat` every second per product                                                                              | four symbols ticking every second; ping frames every 20 s; 24 h max per connection                                      |
| Candles        | `GET /products/{id}/candles?granularity=60`, 300 per request: 5 a day; `[time s, low, high, open, close, volume]` | `GET /api/v3/klines?interval=1m`, 1,000 per request: 2 a day; `[open time ms, open, high, low, close, …]`, oldest first |
| Limits         | public REST 10 requests/s per IP                                                                                  | klines weight 2 of 6,000/min per IP                                                                                     |

Binance's defaults are its market-data-only hosts, `data-stream.binance.vision` and
`data-api.binance.vision`: the same public data as `stream.binance.com` and `api.binance.com`, with
no account features. Step 3 makes all four URLs configurable.

A price leaves a provider as **cents, not rounded**: `"60510.855"` becomes `6051085.5`. The tick
rounds once, in step 3. The decimal point is moved in the text, because `35.12 * 100` is
`3511.9999999999995`. Candles are rounded to whole cents (half up) with `bigint` arithmetic on the
string, and a candle the `candles` table would refuse (low above the open, a zero price) is
skipped and logged.

### Staying connected

`ReconnectingSocket` is the part both providers share:

- **`alive`** is "the connection is open and something arrived in the last 5 s". For Coinbase the
  heartbeats make a quiet HYPE minute still alive; whether the coin's own price is too old is the
  rate provider's question (step 3).
- **Reconnect** after any close: 1 s, doubling to 30 s, each ×(0.5–1). The backoff resets only once
  a connection has delivered a message, so a server that accepts and closes at once still backs
  off.
- **Stall:** an open connection that receives nothing, not even a ping, for 30 s is terminated and
  replaced. A half-open TCP connection would otherwise look open forever.
- **At once:** Binance's `serverShutdown` drops the connection and reconnects without waiting out
  the backoff.
- `disconnect()` closes and stops reconnecting for good.

### Fake exchanges

`FakeCoinbase` and `FakeBinance` run an HTTP server with WebSocket upgrades on a random local port
and speak each exchange's protocol: subscriptions, tickers and heartbeats, mini-tickers, candles
(Coinbase's newest first with both ends of the range included and a 400 above 300 rows, Binance's
oldest first with `limit`). Tests break them with `setPrice`, `silence(symbol)`, `mute()`,
`drop()`, `refuse(status)`, `failRest(status)`, `shutdownNotice()` and `sendRaw(text)`. Step 3's
failover tests (2–6) run against the same fakes.

## How it was verified

`npx nx test market --testPathPatterns=prices/providers` (37 tests, ~20 s, no containers, no
internet; run twice):

- Coinbase: one subscribe for the four products with `ticker` and `heartbeat`; the current ticker
  arrives right after it, in cents; heartbeats alone keep it alive; a muted connection stops
  being alive and is replaced after the stall timeout; after a drop it backs off through refused
  upgrades (503), reconnects and subscribes again; malformed tickers, unknown products, zero
  prices and `error` messages are ignored; nothing after `disconnect()`.
- Binance: one combined stream with the four lowercase `@miniTicker` names; the same failure
  cases (451 on the upgrade); `serverShutdown` reconnects at once although the backoff is 10 s.
- Candles: a day is 1,440 candles in five Coinbase requests (the first ends at 04:59) or two
  Binance requests (the second starts at minute 1,000); the range is kept (`from` rounded up to a
  whole minute, `to` excluded); a refusal is a `ProviderError` with the status (429, 451), an
  unreachable host one without.
- `centsOf` rounds half up on the string; `floatCentsOf` keeps the fraction of a cent exactly.

`npx nx run-many -t lint build -p market` green (webpack compiled successfully),
`tsc -p apps/market/tsconfig.spec.json` clean.

Formats and limits were checked against the exchanges' API documentation, and the four pairs were
confirmed to be trading on both (Coinbase `online`, Binance `TRADING`).

## Terms of use

Both exchanges' public market data needs no key, but it comes with terms. Read on 2026-11-27:

|                  | Binance                                                                                                            | Coinbase                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Document         | Terms of Use (ADGM entities, effective 27 October 2026); APIs are "subject to separate API terms", not yet read    | Market Data Terms of Use (last updated 7 August 2026)                                                                            |
| Licence          | Non-commercial personal or internal business use                                                                   | Personal or research use only; not for an application with end users other than you                                             |
| Showing it       | Within that licence                                                                                                | Not to anyone outside your organisation without written consent: neither the data nor anything derived from it (charts, candles) |
| Also prohibited  | Getting around the List of Prohibited Countries (a VPN, for example)                                               | "Generic or fair value prices" and valuations of digital currencies, "whether for internal use or otherwise"; any use for AI     |

What follows for NexusPay:

- **Binance is the preferred provider** (`MARKET_PRICE_PROVIDERS=binance,coinbase`, also the
  default). Coinbase prices a coin only while Binance can't: settling trades and valuing
  portfolios at its price is close to the valuation clause, so it is kept to the fallback.
- **Live prices are for running NexusPay locally, for yourself.** No deployment, demo or
  screenshot with them: the market is in neither the Helm chart nor `docker-compose.apps.yaml`,
  `MARKET_LIVE_PRICES` unset is off, and these docs quote no real prices.
- Anything more (other users, a public demo) needs Binance's API terms read and Coinbase's
  written consent (marketdata@coinbase.com), or another source.

## Lessons

- **Move the decimal point in the text.** `Number('35.12') * 100` is off by a ten-trillionth, which
  is enough to fail an equality and, rounded the wrong way at a half cent, to move a price.
- **A provider says whether the connection is alive, not whether a coin is fresh.** Keeping those
  apart lets step 3 tell "Coinbase is down" (every coin fails over) from "one pair is halted"
  (only that coin does).
