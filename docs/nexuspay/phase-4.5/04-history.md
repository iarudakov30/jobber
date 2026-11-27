# Step 4 — History

- **Where:** committed directly to `main`.

## Why

After step 3 a live coin's chart only had the minutes a leader had ticked: a fresh install showed
an empty day, and every leader change left a gap. The exchanges keep 1-minute candles for years,
and step 2's providers can already read them. This step uses them in two places:

- **`GenerateCandles` for a live coin** loads that day's candles from the exchanges, so the
  `BackfillCandles` job fills BTC, ETH, HYPE and ZEC like it fills the simulated coins;
- **on becoming leader**, a replica fills the last 24 h of missing live minutes, so the chart is
  full without running a job and the gap a leader change leaves is closed.

Either way only minutes without a candle are written: a minute a leader built from its own
ticks wins, because those are the prices people traded at.

## What changed

| Area                                                                      | Change                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prices/live/live-history.ts`                                             | `LiveHistory`: `loadDay(coin, day)` for `GenerateCandles`, `fillRecent()` on leadership; providers in preference order, the next one on any error |
| `prices/live/live.module.ts`                                              | `LiveModule`: `LivePrices`, `LiveHistory` and their options, one instance shared by `PricesModule` (the leader) and `BackfillModule` (gRPC)       |
| `backfill/market.controller.ts`                                           | A live coin goes to `LiveHistory`; `INVALID_ARGUMENT`, `FAILED_PRECONDITION` (live prices off), `UNAVAILABLE` (every exchange refused)            |
| `prices/backfill.ts`                                                      | `backfillDayStart(day, now, allowToday)`: the day rules, with today allowed for live coins                                                        |
| `prices/simulator.service.ts`                                             | Starts `fillRecent()` in the background when it starts leading                                                                                    |
| executor `backfill-candles.consumer.ts`                                   | `FAILED_PRECONDITION` is dead-lettered at once, like `INVALID_ARGUMENT`                                                                           |
| `market.proto` (and the generated types)                                  | `GenerateCandles` comments: live coins, today, the error codes                                                                                    |
| `jest.config.cts`, `src/testing/offline.ts`                               | Tests never read the live switch from `apps/market/.env` (see below)                                                                              |
| `src/testing/fake-exchanges.ts`                                           | `fakeCandles(start, count, price)` for ranges that cross midnight                                                                                 |
| `backfill.api.spec.ts`, `live-prices.api.spec.ts`, `live-history.spec.ts` | Acceptance test 8 against the fake exchanges; the fill's decisions with stubs                                                                     |

## How it works

### `GenerateCandles` for a live coin

| Case                                       | Result                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A day from 2020-01-01 to yesterday         | The day's candles from the first exchange in `MARKET_PRICE_PROVIDERS` that answers; `written` = new minutes |
| Today                                      | The same, up to the last completed minute                                                                   |
| A repeat                                   | `written: 0`                                                                                                |
| A day before the pair was listed           | The exchange returns no candles: `written: 0`                                                               |
| After today, before 2020, not a date       | `INVALID_ARGUMENT`: dead-lettered at once                                                                   |
| `MARKET_LIVE_PRICES` off                   | `FAILED_PRECONDITION`, nothing asked of the exchanges: dead-lettered at once                                |
| Every exchange refuses or can't be reached | `UNAVAILABLE`, nothing written: Pulsar redelivers (5 s, 5 times), then the job's DLQ                        |

A day costs two Binance requests (1,000 candles each) or five Coinbase ones (300 each). An
exchange that fails part-way through a day is dropped for that day and the next one is asked for
all of it, so the day never mixes exchanges. Turning live prices off stops the history too: unset,
nothing reaches the internet, not even for a job someone started.

The job itself still stops at yesterday: today's minutes are the fill's below, and a job item
for a moving day would mean something different on every redelivery.

### The 24 h fill on leadership

When a replica starts leading, and only with `MARKET_LIVE_PRICES=on`:

1. The window is the 24 h before the current minute; the current one is the ticker's.
2. Per coin, the minutes in the window that have a candle are read from PostgreSQL.
3. None missing: nothing is asked. Otherwise one range, from the first missing minute to the last,
   goes to the exchanges, and `insertMissing` skips the minutes in between that already have one.
   After a short leader change that is one request per coin.
4. Logged per coin, `BTC: filled 3 of 3 missing minute(s) of the last 24 h from binance`, or once
   for all, `No minute of the last 24 h missing for BTC, ETH, HYPE, ZEC`. A failure is a warning
   for that coin, and the others still fill.

It runs in the background, so the first ticks don't wait for REST, and one fill at a time.

Two consequences of "ticked minutes win":

- A minute in which a leader handed over keeps its partial candle (the leaders' upsert merges what
  each saw); the exchange's full candle for it is not used.
- A leader that dies without its shutdown hook (a crash, or `timeout` on Windows, which ends the
  process at once) loses the minute it was building. The next leader fills that minute from the
  exchange.

### Tests no longer read the live switch

Step 3's full test run was reported as not reaching the internet with `MARKET_LIVE_PRICES` unset.
That wasn't guaranteed: Nx loads `apps/market/.env` into every task, `nx test` included, and the
committed `.env` has `MARKET_LIVE_PRICES=on`. A suite that builds the app from its environment
(`market.api.spec.ts`) connected to the real exchanges: this step's first full run showed BTC
ticks with `source: binance` in a suite that expects none.

`src/testing/offline.ts`, in jest's `setupFiles`, now deletes `MARKET_LIVE_PRICES`,
`MARKET_PRICE_PROVIDERS` and the four endpoint variables before any test file loads. The suites
that need live prices pass `LIVE_PRICES_OPTIONS` themselves, pointed at the fake exchanges.

## How it was verified

- `backfill.api.spec.ts` (8 tests, Testcontainers PostgreSQL, gRPC over a real client, Binance
  first as in production), **acceptance test 8**:
  - BTC for yesterday: 1,440 candles, in cents, equal to the fake Binance's, in two requests
    (none to Coinbase); the repeat writes 0 and changes nothing;
  - ETH with Binance's REST refusing (451): 1,440 from Coinbase, in five requests;
  - HYPE with both refusing (503, 429): `UNAVAILABLE`, nothing written;
  - ZEC today: as many candles as completed minutes, none for the current one;
  - a live coin with live prices off: `FAILED_PRECONDITION`, no request to either exchange;
  - the simulated coins' cases as before; a live coin after today or before 2020 is
    `INVALID_ARGUMENT`.
- `live-prices.api.spec.ts`, **test 8's fresh leader**: before the replica starts, the fakes get
  24 h of BTC candles (Coinbase's and Binance's different) and the table one minute a previous
  leader ticked. After leading, every minute of the 24 h is there, equal to the fake Coinbase's
  (first in that suite), except the ticked one, left as it was.
- `live-history.spec.ts` (7 tests, stubs): nothing asked when nothing is missing, one log line;
  one range from the first missing minute to the current one; the next provider on a refusal, a
  warning when all refuse, the other coins still filled; one fill at a time; nothing while off;
  today stops at the last completed minute.
- `backfill.spec.ts`: the day rules with today allowed. The executor's consumer spec:
  `FAILED_PRECONDITION` is dead-lettered.
- `npx nx test market --runInBand`: 14 suites, 167 tests, no request to the exchanges' hosts in
  the log.
- `npx nx run-many -t lint build -p market executor` green (webpack compiled successfully). The
  regenerated gRPC types differ from the old ones only in the comments.
- By hand against the real exchanges (the built bundle with `apps/market/.env`), counts only:
  the first run filled 1,439 of 1,439 missing minutes per coin from Binance (one minute already
  had a candle from an earlier run's ticks); a second run 30 s later found nothing missing; a
  third filled 1 of 1, the minute the second run was building when `timeout` ended it. Binance
  answered every time, so no Coinbase data was loaded.

## Lessons

- **Know what the runner puts in the environment.** "Unset means off" protected nothing once the
  task runner loaded the app's `.env` into the tests. A guard that runs before every test file
  makes it true whatever the shell or `.env` says.
- **Fill the gap, not the window.** Reading what's there first and asking only from the first
  missing minute to the last keeps a restart to one small request per coin, instead of a day of
  candles from every exchange on every leader change.
