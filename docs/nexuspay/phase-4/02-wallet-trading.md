# Step 2 — Wallet trading

- **Where:** committed directly to `main`.

## Why

The market (steps 3 and 4) prices trades, but only the wallet moves money. Before the market
exists, the wallet has to be able to:

- **settle a trade** against a counterparty that always has coins and USD, and charge the fee;
- **reserve money for a limit order** that may fill hours later, be cancelled or expire;
- **survive the market retrying anything**, because a gRPC call can time out after the wallet
  committed;
- **tell the browser** that a balance changed, from every posting, not only from trades.

Doing this first means steps 3 and 4 build against a wallet that is already tested, including
the races that matter: two retries of one trade, and a cancel racing a fill.

## What changed

| Area            | Change                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/wallet`   | `TradingService` (`trading/`): `placeHold`, `releaseHold`, `settleTrade`, `positions`. System accounts `market_maker`, `fees`, `genesis`; inventory refill. gRPC `SettleTrade` / `PlaceHold` / `ReleaseHold` |
| `apps/wallet`   | Migration `0005_holds.sql`: `holds` table (`ACTIVE` / `CAPTURED` / `RELEASED`) and a partial index on trades by user for `positions`                                                                         |
| `apps/wallet`   | `LedgerService.postIn(tx, input)` posts inside the caller's transaction; `findPosting`. Every posting writes a realtime `balance` message per (user, asset) it touched                                       |
| `apps/wallet`   | GraphQL `positions` (`Position { coin, qty, costBasis, averagePrice }`); `schema.gql` updated. The gRPC errors: `NOT_FOUND` for an unknown hold, `FAILED_PRECONDITION` for a hold no longer active           |
| `libs/rabbitmq` | `realtime.ts`: `REALTIME_EXCHANGE`, `userChannel()`, `priceChannel()`, `realtimeTopology()`, `RealtimeBalanceMessage`, `RealtimeFillMessage`. `mergeTopologies()`                                            |

## How it works

### Three system accounts

| Account        | Assets     | Role                                                                    |
| -------------- | ---------- | ----------------------------------------------------------------------- |
| `market_maker` | USD, coins | The other side of every trade. Its USD may go negative (it's the house) |
| `fees`         | USD        | Every trade's fee                                                       |
| `genesis`      | coins      | Where coins come from; minus every coin in circulation                  |

All three are created on first use, like `seed` and `stripe_clearing`. Nothing seeds them in a
migration: the first trade in a coin finds the market maker at 0 and refills it (below).

### Holds

A limit order reserves its money before it can fill. The hold's id is the order's id.

```
PlaceHold(holdId, userId, asset, amount)
  INSERT holds (ACTIVE) ON CONFLICT DO NOTHING
  post 'hold' (externalRef = holdId): user available −amount, user held +amount
```

Both happen in one transaction, so a hold row exists exactly when its posting does. Without
enough funds the posting fails, the transaction rolls back, the row goes with it, and the market
marks the order `REJECTED`. A retry finds the row (`ON CONFLICT`), checks the terms are the same,
and returns the first posting with `duplicate: true`. Twenty parallel calls place one hold.

`ReleaseHold(holdId)` locks the hold row `FOR UPDATE`, posts `release` (held → available) and
sets `RELEASED`. Releasing it again returns the first posting. An unknown hold is `NOT_FOUND`;
the market must only release a hold it saw placed.

### Settling a trade

`SettleTrade` posts one ledger transaction, type `trade`, `externalRef = tradeId` (the order's
id). A buy of `qty` for `usdAmount` plus `fee`:

| Account        | USD                | Coin |
| -------------- | ------------------ | ---- |
| user           | −(usdAmount + fee) | +qty |
| `market_maker` | +usdAmount         | −qty |
| `fees`         | +fee               |      |

A sell is the mirror, with the fee taken from the proceeds: the user gets `usdAmount − fee`. A
leg that would be zero (no fee) is left out, because entries can't be zero.

With a `holdId`, the user's side comes from that hold instead of `available`: the whole hold is
debited from `held`, and whatever the trade didn't need goes back to `available` in the same
posting. A buy at a $20.00 limit for 2 coins holds `2 · 2000 · 1.005 = 4020` cents. If it fills
for $39.90 plus a $0.20 fee, `held` goes down by 4020 and `available` gets back 10 cents. The
hold becomes `CAPTURED`.

The wallet doesn't price anything. The market sends the amounts it already rounded; the wallet
checks their shape (`qty` and `usdAmount` positive, `0 ≤ fee ≤ usdAmount`) and, with a hold, that
the hold is the user's, in the right asset, and large enough.

### Retries and races

Every call is safe to repeat, and the database decides every race:

- **Same trade twice.** The first call inserts `transactions (type 'trade', external_ref)`. A
  concurrent retry waits on that unique key, then finds the posting and returns `duplicate:
true`. A retry with other terms (a market bug) is refused, as transfers refuse a reused
  `Idempotency-Key`.
- **Retry of a limit fill.** `settleTrade` locks the hold row before looking for an existing
  posting. A retry waits for the lock, then finds the first call's posting instead of a
  `CAPTURED` hold it would otherwise refuse.
- **Cancel vs fill.** Both lock the hold row. Whichever comes second finds it `CAPTURED` or
  `RELEASED` and gets `FAILED_PRECONDITION`, with nothing written. The test runs the race 20
  times: exactly one wins every time and `held` ends at zero. The market's own conditional
  `UPDATE … WHERE status = 'OPEN'` (step 4) should stop the loser before it calls; this is the
  second line of defence.

Lock order: hold row first, then accounts in ascending id order. No path locks them the other
way, so they can't deadlock.

### Market maker inventory

After each trade, in the same transaction, the wallet reads the market maker's balance in that
coin (still locked by the posting). Below 100 coins, a second posting, type `inventory`, moves
enough from `genesis` to bring it back to 1,000. Buys never fail for lack of coins, and
`genesis` always equals minus the coins in circulation. The test walks one coin through it:
empty → refill to 1,000; a buy of 950 leaves 50 → refill; a buy of 800 leaves 200 → no refill.

`genesis` is only ever locked by a transaction that already holds the same coin's
`market_maker` account, so taking it last can't deadlock either.

### Realtime messages

`LedgerService.postIn` now ends every posting the same way: for each (user, asset) it touched,
it writes a RabbitMQ record to the `realtime` exchange with routing key `user.<id>`:

```json
{ "type": "balance", "asset": "USD", "available": "7990", "held": "0" }
```

Absolute balances, not deltas, so a client that missed a message is right again after the next
one. Transfers, top-ups, faucet credits, holds and trades all send it without knowing about it.
System accounts send nothing.

A message has to show both balances of the asset even when the posting touched only one of
them. So the posting also locks the other account of each pair (available ↔ held) and reads
both after its updates. Without that lock, a transfer could read `held` while a hold capture was
changing it, and send a balance that never existed.

The order clients can rely on follows from the same locks. Two postings that touch one
(user, asset) take turns on its accounts, and each writes its outbox record while holding them,
so the later change always has the higher outbox id (the `messageId` is `outbox-wallet-<id>`).
Messages for different assets have no such order, so clients compare ids per asset. That
matters for step 5's `seq`.

A trade also writes:

- `trade-executed` on Pulsar (key `userId`), the `TradeExecutedMessage` from step 1;
- a `fill` on `user.<id>`: `{ type: 'fill', orderId, transactionId, coin, side, qty, usdAmount, fee }`.

The wallet declares the `realtime` topic exchange next to the notifications topology
(`mergeTopologies`). Until the gateway exists (step 5), no queue is bound and RabbitMQ drops the
messages, which is what a realtime channel should do when nobody is listening.

### `positions`

```graphql
{
  positions {
    coin
    qty
    costBasis
    averagePrice
  }
}
```

The wallet replays the user's trades in order from their metadata (a partial index on
`metadata->>'userId'` where `type = 'trade'` finds them). A buy adds its quantity and its cost
including the fee. A sell takes cost out at the current average, so the average doesn't change
when selling. `averagePrice` is USD cents per whole coin, rounded down. A sold-out coin
disappears. Coins from the dev faucet have no cost and aren't counted; that's why `transfer`
refuses coins (step 1).

## How it was verified

- **`trading.service.spec.ts`** (36 tests, Testcontainers PostgreSQL):
  - holds: available → held, retry is a duplicate, other terms refused, insufficient funds writes
    nothing (no row, no posting), 20 parallel calls place one hold, release once,
    `NOT_FOUND` for an unknown hold, validation of every field;
  - trades without a hold: exact legs of a buy and a sell, zero fee, **spec test 4** (settle
    twice: one posting, `duplicate: true`), 20 parallel retries settle once, other terms refused,
    a buyer without USD and a seller without coins write nothing;
  - trades with a hold: buy captures and returns the remainder, sell captures coins, a captured
    hold can't be released and a released one can't be captured, too small / wrong asset /
    another user's / unknown holds refused, and the cancel-vs-fill race 20 times;
  - inventory: refills from empty, refills from 50, leaves 200 and 210 alone, `genesis` equals
    minus every coin in circulation;
  - announcements: a trade writes `trade-executed`, both balances and the `fill`; a hold writes
    one balance message with both values, a retry writes none; system accounts write none;
  - positions: average cost through two buys and a partial sell, sold out disappears, other
    users' trades and faucet coins ignored.
- After every test, each asset sums to zero across all accounts and every cached balance equals
  its entries (`expectBooksBalanced`).
- **`wallet.api.spec.ts`:** a limit order end to end over the gRPC controller with wire strings
  (place, settle, settle again); `FAILED_PRECONDITION`, `NOT_FOUND` and `INVALID_ARGUMENT`
  mapping; `positions` over GraphQL; `schema.gql` updated and checked.
- `npx nx test wallet`: 104 tests. `npx nx affected -t lint test build`: green for 6 projects.
  `nexus:codegen` regenerated with no change (no document uses `positions` yet).

## Lessons

- **A snapshot message must be read under the lock that orders it.** Reading `held` without
  locking it could produce a message describing a state that never existed, and an id order
  that meant nothing. Locking the pair costs one extra query per posting.
- **Check for a duplicate after taking the lock, not before.** If `settleTrade` looked for an
  existing posting first and locked the hold second, a concurrent retry would see no posting,
  wait for the hold, and find it `CAPTURED`: a retry of a call that succeeded would fail.
  Under READ COMMITTED each statement sees what committed before it started, so the order of
  the two statements decides the answer.
