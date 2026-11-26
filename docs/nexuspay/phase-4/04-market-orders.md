# Step 4 — Market: orders

- **Where:** committed directly to `main`.

## Why

Step 3 gave the market prices and quotes; step 2 gave the wallet holds and trades. This step
connects them: a user can buy and sell. The hard part isn't the happy path but everything around
it:

- **a market order must trade once**, however often the browser, the market or recovery retries
  it, and even if the market dies between storing the order and calling the wallet;
- **a limit order must hold its funds** until it fills, is cancelled or expires, and must end in
  exactly one of those, even when a cancel and a fill arrive in the same millisecond;
- **a wallet that doesn't answer must not lose money or orders.** A timeout says nothing about
  whether the wallet committed.

## What changed

| Area            | Change                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/market`   | `orders` table (migration `0001_orders.sql`, with `outbox` and `idempotency_keys`). `orders/`: `OrdersService`, `OrderSettlement`, `OrderMatcher`, `OrderRecovery`, `OrderCommandsConsumer` |
| `apps/market`   | GraphQL `placeOrder(input)` (`@Idempotent()`), `cancelOrder(id)`, `orders(status, first)`; errors `QUOTE_EXPIRED` and `ORDER_NOT_OPEN`; `schema.gql` updated                                |
| `apps/market`   | gRPC client to the wallet (`WALLET_GRPC_SERVICE_URL`), `WalletClient`. `market.commands` queue (`order.*`) and the delay buckets. `ORDER_EXPIRY_BUCKET`, `FAULT_CRASH_BEFORE_SETTLE`        |
| `apps/market`   | `SimulatorService.onTick()`: the matcher runs after each of the leader's ticks                                                                                                              |
| `libs/rabbitmq` | `commands.ts`: `COMMANDS_EXCHANGE`, `DELAY_BUCKETS`, `delayBucket()`. `payments` now takes them from here                                                                                   |

## How it works

### The order and its states

```
market:  SETTLING ──────────────────────────────▶ FILLED
             └──▶ REJECTED (too few funds)

limit:   PLACING ──▶ OPEN ──▶ SETTLING ──▶ FILLED
            │          ├──▶ CANCELLED (cancelOrder)
            │          └──▶ EXPIRED   (order.expire)
            └──▶ REJECTED (too few funds)
```

The order's id is the wallet's `tradeId` and, for a limit order, its `holdId`. Its trade terms
(`usdAmount`, `fee`) are fixed when the order is created, from the quote or from the limit price,
and stored on the row. Every retry of `SettleTrade` therefore sends exactly the same terms; the
wallet refuses a retry with different ones.

Every status change is a conditional update:

```sql
UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND user_id = $2 AND status = 'OPEN'
```

When two changes race, one updates a row and the other updates none. The one that updated
nothing reads the order and reports what happened instead.

`PLACING` isn't in the spec. It's what makes the wallet's hold contract safe: the market must
release or capture only a hold it saw placed (an unknown hold is `NOT_FOUND`). An order becomes
`OPEN` only after `PlaceHold` succeeded, and only an `OPEN` order can be matched, cancelled or
expired. A cancel of a `PLACING` order gets `ORDER_NOT_OPEN`, "still being placed".

### Talking to the wallet

`OrderSettlement` makes the three wallet calls, and `WalletClient` sorts their errors into two
kinds:

- **Refused** (`FAILED_PRECONDITION`, `INVALID_ARGUMENT`, `NOT_FOUND`): the wallet answered and
  wrote nothing. Too few funds makes the order `REJECTED` with the wallet's reason
  (`insufficient USD`). Anything else is a bug and is logged as an error.
- **Unknown** (timeout after 5 s, connection lost, any other status): the wallet may or may not
  have committed. The call is repeated with the same id after 200 ms and 1 s. The wallet makes
  that safe: a repeat posts nothing and answers `duplicate: true`. After three attempts the order
  is left as it is, and recovery takes over.

### Market orders

```
placeOrder({ type: MARKET, quoteId })      Idempotency-Key required
  take quote:<id> (only if it's this user's)    missing → QUOTE_EXPIRED
  INSERT order SETTLING with the quote's price, usdAmount, fee
  SettleTrade(tradeId = order.id)
  UPDATE … SET status = 'FILLED', transaction_id WHERE status = 'SETTLING'
```

The quote is taken with a Lua script, not a plain `GETDEL`: another user's attempt neither gets
the quote nor uses it up. The order is stored before the wallet is called, so a crash in between
leaves a `SETTLING` order for recovery, never a trade the market doesn't know about.

`@Idempotent()` returns the stored answer to a retry with the same key. The order also stores
the key (`request_key`, unique per user). If the interceptor lost the first answer (it stores it
after the handler) and runs the handler again, `place` finds the order by its key and returns it,
rather than reporting the already-used quote as expired.

### Limit orders

```
placeOrder({ type: LIMIT, coin, side, qty, limitPrice })
  one transaction: INSERT order PLACING + outbox order.expire → delay.24h
  PlaceHold(holdId = order.id): buy → USD usdAmount + fee, sell → the coins
  UPDATE … SET status = 'OPEN' WHERE status = 'PLACING'
```

A limit order fills at its limit price: `usdAmount = limit · qty / 10^8` (up for a buy, down for
a sell) and the 0.5% fee, as for a quote but without the spread. A buy holds exactly what it
will pay, the spec's `qty · limit · 1.005` rounded up: 2 NXC at $40.00 hold $80.40. Nothing
comes back to `available` when it fills.

### Matching

After every tick, the leader's `OrderMatcher` claims every open limit order the price crossed,
in one statement:

```sql
UPDATE orders SET status = 'SETTLING', fill_price = limit_price
 WHERE status = 'OPEN' AND type = 'LIMIT'
   AND ((coin = 'NXC' AND ((side = 'BUY' AND limit_price >= <low>) OR (side = 'SELL' AND limit_price <= <high>))) OR …)
RETURNING *
```

Then it settles each claimed order (eight at a time) with `holdId` set: the wallet takes the
trade out of `held` and marks the hold `CAPTURED`.

Matches don't queue up. If a match is still running when ticks arrive, each tick widens a pending
`low`–`high` range per coin, and the next match uses that. A price that crossed a limit for one
second while a match was running is still seen.

Two leaders for a moment (a GC pause, step 3's risk) both run the claim. The row lock and the
`WHERE status = 'OPEN'` let each order be claimed by one of them; the other's update re-checks the
row after the first commits and skips it.

### Cancel and expiry

`cancelOrder(id)` and `order.expire` both move `OPEN` to their final status with the same kind of
conditional update, then call `ReleaseHold` and set `released_at`. Cancelling a cancelled order
returns it. Any other status gives `ORDER_NOT_OPEN`.

`order.expire` is written to the outbox in the same transaction as the order, so every limit
order has one. The relay publishes it to the delay bucket named by `ORDER_EXPIRY_BUCKET`
(`delay.24h`). After the bucket's TTL it reaches `commands` with its routing key and lands in
`market.commands`. Any replica's consumer expires the order. If the order is still `PLACING`
then, the consumer throws and the command is retried (5 s, 30 s, 5 min).

The delay buckets are shared with `payments`: RabbitMQ refuses to redeclare a queue with a
different TTL. Their definitions moved to `libs/rabbitmq` (`commands.ts`), so the two services
can't drift apart.

### Cancel vs fill

Both are conditional updates on `status = 'OPEN'`:

- **The cancel wins:** the order is `CANCELLED` and the claim skips it. The hold is released.
- **The fill wins:** the order is `SETTLING`, the cancel updates nothing and answers
  `ORDER_NOT_OPEN`. The hold is captured.

The wallet's own hold lock (step 2) would also stop the loser, but here it never has to:
the loser never calls the wallet.

### Recovery

`OrderRecovery` runs on every replica every 10 s and retries orders that haven't changed for
30 s:

| Stuck in                                    | Retry                     | Then                 |
| ------------------------------------------- | ------------------------- | -------------------- |
| `SETTLING`                                  | `SettleTrade`, same terms | `FILLED`             |
| `PLACING`                                   | `PlaceHold`, same amount  | `OPEN` or `REJECTED` |
| `CANCELLED` / `EXPIRED`, `released_at` null | `ReleaseHold`             | `released_at` set    |

Two replicas retrying the same order at once is harmless for the same reasons as a retry.

`FAULT_CRASH_BEFORE_SETTLE=1` (ignored in production) exits the process after a market order is
stored and before `SettleTrade`, which is how acceptance test 7 was run by hand.

## How it was verified

- **`orders.api.spec.ts`** (21 tests): real replicas of the app against Testcontainers
  PostgreSQL, Redis and RabbitMQ. `auth` is faked. The wallet is a fake **gRPC server**
  (`testing/fake-wallet.ts`) on the real `wallet.proto`, reached through the market's real
  client. Behind it is an in-memory ledger with the wallet's rules: idempotent by id, too few
  funds refused with nothing written, a hold captured or released once. It can fail a call
  before or after applying it. After every test the fake's books must be sound: no negative
  user balance, `held` equal to the active holds, every posting balanced.
  - **Acceptance test 3:**
    - a buy moves exactly the five legs (user USD −8461, market maker +8418, fees +43, market
      maker NXC −2, user NXC +2);
    - a sell is the mirror;
    - reusing the `quoteId` gives `QUOTE_EXPIRED`, and so does waiting 10 s;
    - another user's quote gives `QUOTE_EXPIRED` and stays usable by its owner;
    - the same `Idempotency-Key` replays the order, with one `SettleTrade`;
    - too few funds gives `REJECTED`;
    - a lost answer is retried and settles once;
    - a wallet that's down leaves `SETTLING` until recovery fills it;
    - malformed inputs are refused with messages that start with the field name.
  - **Acceptance test 5:**
    - a buy holds $80.40 and doesn't fill at $40.01, fills at $39.90 at its $40.00 limit, and
      `held` goes to zero;
    - a sell holds its coins;
    - cancel releases the hold; cancelling again returns the order; a filled order gives
      `ORDER_NOT_OPEN`;
    - expiry through `delay.1m` (shortened to 2 s) releases the hold;
    - too few funds gives `REJECTED` with no hold;
    - `PLACING` while the wallet is down can't be cancelled, and recovery opens it;
    - lost answers to `PlaceHold` and `ReleaseHold` are retried, and recovery retries a release;
    - two matchers at once settle each of 10 orders once;
    - the simulator leader's own ticks fill a crossing order.
  - **Acceptance test 6:** 100 times, a cancel over GraphQL and a crossing match fired together
    with random jitter. Each order ends either `CANCELLED` (hold released, no trade) or `FILLED`
    (hold captured, no release, the cancel gets `ORDER_NOT_OPEN`). Final balances equal the sum
    of the fills. One run: 78 fills, 22 cancels; the test requires both outcomes to occur.
  - **Acceptance test 7:** a replica whose fault hook throws after storing the order is shut
    down. Another replica's recovery settles the order: one trade, the right balances.
  - `orders` lists a user's orders newest first and filters by status.
- `pricing.spec.ts`: limit terms over 5,000 random cases. A buy's hold equals its total; a sell
  holds its quantity.
- `market.api.spec.ts` now starts replicas with `OrdersModule`, as the app does, so the schema
  check covers the new API.
- `npx nx test market`: 78 tests. `npx nx affected -t lint test build`: green for 20 projects,
  `payments` included. Every build printed `webpack compiled successfully`.
- **By hand against the real `auth` and `wallet`** (Docker Compose, `wallet:seed`, alice):
  - a market buy of 0.5 NXC at $41.98: USD went from 12250 to 10140 cents (−2110 = 2099 + 11
    fee), NXC +0.5, `positions` showed the cost; reusing the quote gave `QUOTE_EXPIRED`;
  - a limit buy at $10.00 held 1005 cents; the cancel released them;
  - a limit buy $1 above the price filled on the next tick at its limit;
  - **test 7 live:** with `FAULT_CRASH_BEFORE_SETTLE=1` the process exited (code 1) with the
    order `SETTLING` and the wallet untouched. After a restart without the flag, recovery logged
    `1 → FILLED` 32 s after the order was created. The wallet had exactly one `trade`
    transaction for it, and USD went down by the order's total once.

## Lessons

- **The build is a test the unit tests don't run.** All 78 tests passed, and the built app
  crashed on startup: the runtime schema object included the idempotency table, imported from
  `@jobber/idempotency/table`, a path the bundle's module aliases don't map. Jest resolves it
  through `tsconfig` paths, so only running the bundle shows it. `payments` already kept that
  table (and `outbox`) for drizzle-kit only; now the market does too.
- **Leave a state between "asked" and "confirmed" when the other side's contract needs it.** The
  spec's limit order goes straight to `OPEN` and then asks for the hold. Then a cancel or a fill
  could reach the wallet for a hold that was never placed (`NOT_FOUND`), or a hold placed after
  the order was already cancelled would never be released. `PLACING` costs one status and one
  recovery query.
- **Fix the terms when the order is created, not when it's settled.** Recomputing `usdAmount`
  in recovery from a price read later would send different terms, and the wallet rightly refuses
  a retry that changed them. Storing them makes every retry identical.
- **A race test needs both outcomes.** The first run of the cancel-vs-fill test passed, but a
  test where the fill always won would pass too and prove nothing about the cancel. Jitter plus a
  check that both outcomes happened makes it a race test.
