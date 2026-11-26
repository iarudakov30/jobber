# Step 6 — Candle backfill

- **Where:** committed directly to `main`.

## Why

The market writes candles only while its simulator runs. A fresh install, or a market that was
stopped for a few days, has charts with nothing to show before it started. The Trade screen
(step 7) shows a day of 1-minute candles, and it should have a past to show.

Generating history is a batch of independent, repeatable units of work: one coin, one day. That
is what the `jobs` / `executor` framework already does (phase 1): a job with one item per unit,
an outbox that can't lose them, a consumer that counts each item once. This step plugs the
market into it.

## What changed

| Area            | Change                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/market`   | `prices/backfill.ts`: a day of candles generated from the coin and the day alone. `CandleStore.insertMissing`. gRPC server on 5004 (`MARKET_GRPC_SERVICE_URL`) with `GenerateCandles`    |
| `apps/jobs`     | `BackfillCandlesJob`: `data` is a range (`{ from, to?, coins? }`) or a list of `{ coin, day }`; one item per coin-day. `AbstractJob.itemErrors()`: per-item checks beyond the decorators |
| `apps/executor` | `BackfillCandlesConsumer`: calls `GenerateCandles`; a refused day is dead-lettered, an unreachable market is redelivered                                                                 |
| Libraries       | `BackfillCandlesMessage` (`libs/pulsar`), `Jobs.BACKFILL_CANDLES` (`libs/nestjs`), `market.proto` comments (the semantics below)                                                         |
| Workspace       | `npm stop` frees 5004; `apps/jobs/tsconfig.spec.json` targets ES2021 like the app (tests now load `@jobber/money`, which uses `bigint` literals)                                         |

## How it works

```
executeJob(name: "BackfillCandles", data: { from: "2026-11-20", to: "2026-11-22", coins: ["NXC", "ORB"] })
  jobs:      one Job row + 6 outbox records (NXC 11-20, ORB 11-20, NXC 11-21, ...)   one transaction
  Pulsar:    topic BackfillCandles
  executor:  BackfillCandlesConsumer → market gRPC GenerateCandles({ coin, day }) → Acknowledge
  market:    generate the day's 1,440 candles, insert the minutes that have none
```

### The job

`data` is either a range or the items themselves:

```json
{ "from": "2026-11-01", "to": "2026-11-25", "coins": ["NXC"] }
[{ "coin": "NXC", "day": "2026-11-01" }, { "coin": "ORB", "day": "2026-11-02" }]
```

A range becomes one item per coin per day, oldest day first. `to` defaults to yesterday and
`coins` to all four. The job refuses, before it exists:

- a range that isn't two dates in order, that starts before 2020-01-01, that reaches today, or
  that covers more than 10,000 coin-days (the job framework's limit);
- an item whose coin isn't one of `COINS`, or whose day isn't a real date from 2020-01-01 to
  yesterday.

All of an item's problems come back together (`data[3]: day must be ...`). The message class in
`libs/pulsar` checks only the shape (a coin code, a `YYYY-MM-DD` string), as `TradeExecutedMessage`
does: importing `@jobber/money` there would pull `bigint` code into every user of the library.
The rest is the new `AbstractJob.itemErrors(item)` hook, which runs after each item's decorators
and adds its messages with the same `data[i]:` prefix.

### The generated day

The same coin and day must give the same candles on every replica and on every repeat. The live
simulator's seed (`MARKET_SEED`) can't be used: it is random on each replica when unset. So
everything comes from a fixed seed, the coin and the day:

- **Daily anchors.** The price at 00:00 UTC of each day since 2020-01-01. It is a walk in log
  price with the coin's daily volatility, pulled back by 5% of the gap each day towards the
  coin's start price (an Ornstein–Uhlenbeck process). A plain walk over six years would have put
  WISP (σ = 25% a day) at a fraction of a cent or at millions. This one keeps the past within
  the range the live market starts from. Each coin has one stream, read in order, so anchor n is
  the same whatever was computed first (cached per process).
- **Within the day.** A one-second Brownian bridge from that day's anchor to the next day's: a
  free walk with the coin's per-second volatility, bent linearly so it ends at the next anchor.
  The day moves like the live market, and its last second meets the next day's first. Each
  minute's open, high, low and close come from its 60 seconds, in whole cents (at least 1).

No news shocks; generated history is quieter than the live market in that one way.

### Writing: live candles win

`CandleStore.insertMissing` inserts with `ON CONFLICT DO NOTHING` and returns how many rows it
wrote:

- a minute the live simulator wrote keeps its real candle;
- a repeat (a redelivered message, the same job run again) writes nothing and reports 0;
- the days have to be in the past anyway: the market refuses today (`INVALID_ARGUMENT`), which
  belongs to the simulator.

That replaced the step 1 contract, which said the call would upsert and overwrite: an upsert
would have merged generated prices into real candles of the same minute (the live upsert widens
high and low). `market.proto`'s comments now say what it does, and the TypeScript was
regenerated (comments only).

### The consumer

`BackfillCandlesConsumer` follows `LedgerAuditConsumer`:

- it calls `GenerateCandles` and logs `Backfill (job 43) NXC 2026-11-20: 1440 candle(s) written`;
- `INVALID_ARGUMENT` becomes `NonRetryableError`: the message is dead-lettered at once, since a
  retry would be refused the same way;
- any other error (market down) fails the message, and Pulsar redelivers it;
- `MARKET_GRPC_SERVICE_URL` is optional (default `localhost:5004`), so executor deployments
  without the market still start.

Any market replica can serve `GenerateCandles`: there is no leader for it, and two replicas
generating the same day write the same rows, once.

## How it was verified

- **`backfill.spec.ts`** (`market`, 14 tests):
  - the same coin and day give identical candles; another day or coin gives others;
  - 1,440 candles on that UTC day's minutes, each a real candle (`0 < low ≤ open, close ≤ high`),
    for every coin;
  - one day's last close is within 2 cents or 1% of the next day's first open;
  - over 200 days, a day's open-to-close spread is within 25% of the coin's σ (NXC, WISP);
  - anchors stay within 5 stationary spreads of the start price for six years, for every coin;
  - anchors don't depend on which days were asked for first (a fresh module asked out of order);
  - every refusal: bad format, impossible date, before 2020-01-01, today, the future.
- **`backfill.api.spec.ts`** (`market`, Testcontainers PostgreSQL): the real controller as a Nest
  gRPC microservice, called through a real client on `market.proto`.
  - a day writes 1,440 rows equal to the generator's output, and a repeat writes 0 and changes
    nothing;
  - a live candle in the day is left alone and the 1,439 other minutes are filled;
  - a bad coin, a bad date, a day before 2020 and today get `INVALID_ARGUMENT` with the message,
    and nothing is written.
- **`backfill-candles.spec.ts`** (`jobs`, 5 tests): a range becomes coin-day items, oldest first,
  in one outbox write; defaults (every coin, up to yesterday); explicit items; refused ranges;
  refused items with every message of an item together.
- **`backfill-candles.consumer.spec.ts`** (`executor`): the call and the log line; a refused day
  is a `NonRetryableError`; an unreachable market fails the message for redelivery.
- **By hand** with the real `auth`, `jobs`, `executor`, `market`, Pulsar and PostgreSQL (built
  bundles): `executeJob` for NXC and ORB, 2026-11-20 to 22, created job 43 with 6 items. The
  executor logged `1440 candle(s) written` six times, the job went `COMPLETED` (6 of 6), and the
  `market` database had 1,440 candles per coin-day. The same job again (44) logged `0 candle(s)
written` six times, completed, and left the 8,640 rows as they were. Items with `DOGE` and a
  2030 day were refused with both messages before any job existed.
- `npx nx affected -t lint build`: green for 13 projects. `npx nx affected -t test`: green for 10
  (`market` 95, `jobs` 28, `executor` 10).

## Lessons

- **A contract written before the code can be wrong in its details.** Step 1's `market.proto`
  said `GenerateCandles` would upsert. Writing it showed that an upsert would blend generated
  prices into real candles of the same minute. The contract changed to "insert what's missing",
  and the comment says why. It was cheap to change, because nothing called it yet.
- **"Reproducible" needs a seed every replica agrees on.** The simulator is reproducible per
  seed, but its seed is per process when unset. Generated history has to be the same whichever
  replica answers, so it can't depend on anything a replica chooses.
- **Unbounded randomness over long horizons goes somewhere silly.** A geometric walk with a
  quarter of volatility a day ends six years later anywhere from a fraction of a cent to millions.
  Pulling it back towards a home price keeps a demo's history plausible.
