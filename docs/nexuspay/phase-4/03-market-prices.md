# Step 3 — Market: prices

- **Where:** committed directly to `main`.

## Why

Orders (step 4), the realtime gateway (step 5) and the React screens (step 7) all start from a
price. Before any of them, the market has to:

- **produce prices** that move enough to be worth watching, and that a test can reproduce;
- **produce them once**, however many market replicas run, and keep producing them when the
  replica doing it dies;
- **number them**, so a browser can tell a newer tick from an older one, even across a change of
  leader;
- **keep history** as 1-minute candles for the charts;
- **quote a price** for a market order, rounded so the house never loses a fraction of a cent.

## What changed

| Area            | Change                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/market`   | New NestJS app, HTTP 3006, GraphQL at `/market`. `market` database with the `candles` table (migration `0000_candles.sql`). Redis for prices, quotes and the leader lock |
| `apps/market`   | `prices/`: seeded random walk (`PriceSimulator`, mulberry32), `LeaderLock`, `SimulatorService` (election and the 1 s loop), `PriceTicker` (Redis, RabbitMQ, candles)     |
| `apps/market`   | `market/`: GraphQL `coins`, `candles(coin, from, to)`, `quote(coin, side, qty)` (signed in); `pricing.ts` with the spread, fee and rounding rules                        |
| `libs/rabbitmq` | `RealtimePriceMessage` (`{ type: 'price', coin, price, seq, at }`)                                                                                                       |
| Workspace       | `market` in `npm start` and `npm stop`; `apps/market/schema.gql` in `.prettierignore`                                                                                    |

`orders` and `GenerateCandles` are not here yet. The orders table arrives with the orders in step
4, and the gRPC server with its caller, the backfill job, in step 6.

## How it works

### The walk

Each coin follows a geometric random walk, one step per second:

```
p' = p · exp((μ − σ²/2)·Δt + σ·√Δt·Z)        Δt = 1 s in days, Z ~ N(0, 1)
```

`μ` and `σ` are per day and set per coin in `prices/coins.ts`, far above any real asset's, so a
chart moves while someone watches it (NXC moves about 9 cents a minute at $42). Each minute a
coin also has a small chance (0.1–0.6%) of a news shock of ±5–15%.

The random numbers come from mulberry32, a 32-bit generator whose state is one integer. Each coin
gets its own stream, seeded from the run's seed and the coin's code (FNV-1a), so adding a coin
doesn't change the others' prices. `Z` comes from Box–Muller, which always takes exactly two
numbers, so the streams stay aligned. Same seed, same ticks: that is acceptance test 1.

The walk keeps the price as a float in cents. Ticks publish it rounded to whole cents, never
below 1 cent: `price` in every message, quote and candle is a `bigint` of USD cents per whole
coin. The walk itself keeps the float, so rounding never accumulates.

`MARKET_SEED` picks the seed; unset, each replica starts with a random one and logs it.

### One leader

Every replica runs `SimulatorService`, and every one competes for the same Redis key:

```
SET market:simulator <instanceId> NX PX 5000        acquire
if GET == me then PEXPIRE 5000                       renew, every 2 s (Lua)
if GET == me then DEL                                release, on shutdown (Lua)
```

Only the holder ticks. The details that make this safe:

- **The leader's lease ends before the key does.** `LeaderLock` starts its 5 s from the moment
  it _sent_ the command; Redis starts the TTL when the command _arrives_. So a leader that stops
  renewing (lost connection, long GC pause) considers itself done a little before any follower
  can take the key. Every tick checks the lease first.
- **A follower knows when to try.** When `SET NX` fails it asks Redis for the key's `PTTL` and
  tries again 20 ms after it expires, or in 500 ms, whichever comes first. A crashed leader is
  replaced at most 5 s after its last renewal; one that shuts down releases the key and is
  replaced within half a second.
- **A new leader continues, it doesn't restart.** It reads each coin's last unrounded price from
  Redis and moves its walks there; its random streams carry on where they were.
- **Redis unreachable at startup** isn't an election failure: the first attempt waits for the
  client to connect.

`MARKET_SIMULATOR=off` keeps a replica out of the election; it still serves quotes.

### Each tick

```
step every coin's walk
Redis:     EVAL  HINCRBY price:<coin> seq 1; HSET price:<coin> price mid at   (one pipeline)
RabbitMQ:  realtime / prices.<coin>  { type: 'price', coin, price, seq, at }
memory:    add to the coin's 1-minute candle; on a new minute, write the finished one
```

`seq` comes from Redis, not from the leader's memory. A new leader's first tick is therefore the
old leader's last `seq` plus one, and the clients' rule ("drop a tick whose `seq` isn't higher")
keeps working across a failover. The failover test checks exactly that: no gap, no repeat.

Ticks are published straight to RabbitMQ, not through an outbox: non-persistent, with a 5 s
expiration and `messageId = price-<coin>-<seq>`. A tick that can't be sent is simply skipped,
because the next one replaces it a second later. If Redis can't store the tick, nothing is sent
at all, since the tick would have no `seq`.

### Candles

The leader builds each coin's current minute in memory and upserts it into `candles` (key
`(coin, interval, start)`, interval `1m`) when the next minute starts. The upsert merges with
whatever is there: the earlier open stays, high and low widen, the later close wins. That covers
the two ways one minute gets written twice:

- **A change of leader mid-minute.** The old leader writes its partial minute when it steps
  down (or shuts down); the new leader writes its part when the minute ends, and the row ends up
  covering both.
- **A repeat**, such as the backfill job's redelivered message (step 6).

If PostgreSQL refuses a write, the leader keeps the candles (up to a day of them) and writes them
with the next one.

A `CHECK` keeps every row a real candle: `0 < low ≤ open, close ≤ high`.

### Pricing and rounding

```
buy price  = ⌈mid · 1.002⌉          sell price = ⌊mid · 0.998⌋
usdAmount  = price · qty / 10^8, rounded up for a buy and down for a sell
fee        = ⌈usdAmount · 0.005⌉, whichever side
total      = usdAmount + fee (buy)   or   usdAmount − fee (sell)
```

All in `bigint`. Every rounding goes the house's way, by less than a cent each time. Acceptance
test 2 checks it over 20,000 random prices and quantities (from 1 cent to $1,000,000 a coin,
from one minor unit to a million coins) plus the edges around whole cents and whole coins. It
compares cross-multiplied integers, so the test itself never rounds:

- a buyer's total is never less than `mid · 1.002 · qty / 10^8 · 1.005`;
- a seller's total is never more than `mid · 0.998 · qty / 10^8 · 0.995`;
- each rounding moves the amount by less than one cent.

Two NXC at a $42.00 mid: a buy is quoted at $42.09, $84.18 plus a $0.43 fee; a sell at $41.91,
$83.82 minus $0.42.

### GraphQL

```graphql
{
  coins {
    code
    name
    tick {
      price
      seq
      at
    }
    open24h
  }
  candles(coin: "NXC") {
    start
    open
    high
    low
    close
  }
}
mutation {
  quote(coin: "NXC", side: BUY, qty: "200000000") {
    id
    price
    usdAmount
    fee
    total
    expiresAt
  }
}
```

- **`coins`** reads the prices from Redis and, for the 24 h change, the open of each coin's first
  candle in the last 24 hours. `tick` carries the `seq` of the snapshot, so a client can line it
  up with the live ticks that follow.
- **`candles`** returns 1-minute candles, oldest first, by default the last 24 hours and never
  more. The minute in progress isn't in the database yet; the chart builds it from live ticks.
- **`quote`** needs a signed-in user (`GqlAuthGuard`, like wallet and payments). It refuses a
  coin price older than 10 s (`PRICES_UNAVAILABLE`: no replica is leading), a non-positive or
  over-a-million-coins `qty`, and a quantity worth less than a cent. It stores
  `{ userId, coin, side, qty, price, usdAmount, fee }` at `quote:<id>` for 10 s; step 4's
  `placeOrder` takes it with `GETDEL`, so a quote can be used once.

`coins` and `candles` are public. Market data isn't anyone's secret, and the realtime price
channels are public too.

## How it was verified

- **`price-walk.spec.ts`:**
  - **Acceptance test 1:** seed 42 twice gives identical first 1,000 ticks of every coin, and
    the prices really move (1,000 distinct values). Another seed gives other ticks.
  - Each coin's ticks are the same as its walk run alone.
  - Measured daily volatility over a simulated day is within 2% of the configured `σ`.
  - Shocks come at the configured rate, between 5% and 15%, about half of them down.
  - Prices never go below a cent.
  - `gaussian` has mean 0 and variance 1.
- **`pricing.spec.ts`:**
  - **Acceptance test 2:** the property test above.
  - Worked examples: a 1.5-cent amount, the minimum fee, the spread.
- **`candle-builder.spec.ts`:** a minute's open, high, low and close; coins kept apart; gaps;
  merging two partial candles of one minute.
- **`leader-lock.spec.ts`** (Testcontainers Redis):
  - one winner among ten replicas;
  - renewal holds the lock past its TTL;
  - a stopped leader is replaced once its key expires, after its own lease already ended, and
    can't renew back;
  - release hands over at once and never deletes another owner's key.
- **`market.api.spec.ts`:** real replicas of the app against Testcontainers PostgreSQL, Redis
  and RabbitMQ, with the production timings. Only `auth` is faked; a test queue bound to
  `prices.#` receives the ticks.
  - Two replicas: exactly one ticks, once a second per coin, with consecutive `seq`.
  - Messages are non-persistent, expire after 5 s, carry their `messageId`, and one tick covers
    every coin.
  - Candles: a ticker driven with chosen times writes each finished minute and, on flush, the
    open one. Two writes of one minute merge. Candles refused by PostgreSQL are written with the
    next tick.
  - `coins` with ticks and `open24h`. `candles` by range and by default, and its validation.
  - `quote`: buy and sell amounts equal `quoteAmounts` at the stored mid. Redis holds exactly
    the stored quote, with a TTL just under 10 s. It refuses requests without a cookie, bad
    coins and quantities, a number for `qty`, and stale prices.
  - The schema printed on startup matches `apps/market/schema.gql`.
  - **Acceptance test 13**, twice:
    - The leader shuts down: the follower ticks within a second, with `seq` = last + 1.
    - The leader is cut off from Redis (its client disconnected, as in a network partition):
      it stops by itself, the follower leads within 5.5 s of the cut, and the `seq` stream has
      no gap or repeat.
  - The price continues from the old leader's, not from the defaults.
- `npx nx test market`: 55 tests. `npx nx affected -t lint test build`: green for 20 projects;
  the market build printed `webpack compiled successfully`.
- By hand against Docker Compose (`npx nx run market:migrate-drizzle`, `npx nx serve market`):
  - the app took the lock 2 s after starting;
  - `coins` showed `seq` climbing once a second;
  - Redis held `price:<coin>` and `market:simulator` with its TTL;
  - `quote` without a cookie answered `FORBIDDEN`.

## Lessons

- **A failover test has to look at what the old leader can still do, not at its flags.** The
  first version asserted `isLeader === false` on the leader cut off from Redis and failed: the
  flag only flipped at its next tick, up to a second after its lease had already ended. The
  replica couldn't tick by then, because every tick checks the lease. Its own flag was
  describing a past state. `isLeader` now means "may tick right now" (`leading && lease held`).
- **"Hands over at once" needs the follower to be listening.** Releasing the key on shutdown
  saved nothing while followers retried only every 2 s: the first handover took 1.6 s. Followers
  now poll every 500 ms. It costs two Redis commands a second per follower and doesn't need a
  pub/sub connection.
- **The counter that orders messages must outlive whoever sends them.** A `seq` kept in the
  leader's memory would restart at 1 on every failover. Clients would then drop every new tick
  as "older" until it caught up. Keeping it in Redis, incremented in the same script that stores
  the price, makes it a property of the coin, not of the process.
