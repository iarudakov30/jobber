# Step 1 — Contracts

- **Where:** committed directly to `main`.

## Why

The rest of phase 4 builds two new services and teaches the wallet to trade. They depend on each
other in a loop: the market settles trades through the wallet, the wallet tells the realtime
gateway about balances, and a job asks the market for old candles. Settling the shared pieces
first lets each later step build against something fixed and tested:

- **Coins have to be assets before anyone can hold them.** Every account references
  `assets(code)`, and every amount goes through `@jobber/money`. A coin missing from either
  place would fail at the first trade.
- **The market needs a settlement contract it can retry blindly.** A gRPC call can time out after
  the wallet committed. The market must be able to send the same `SettleTrade` again and get "already
  done", not a second trade. That has to be in the contract, not just in the implementation.
- **`trade-executed` gets its shape now,** like `payment-succeeded` did in phase 3, so the
  wallet writes it from day one even though nothing consumes it until phase 5.

## What changed

| Area           | Change                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/money`   | Coins NXC, BLIP, ORB, WISP (scale 8). Each asset now has a `kind` (`fiat` or `coin`); new `COINS`, `FIAT`, `isCoin`, `isFiat`, `CoinCode`, `FiatCode`. `formatAmount` shows coins as `1.50000000 NXC` |
| `apps/wallet`  | Migration `0004_coin_assets.sql` seeds the coins. `balances` lists USD always and a coin only once the user has accounts in it. `transfer` refuses coins                                              |
| `wallet.proto` | `SettleTrade`, `PlaceHold`, `ReleaseHold` with `SettleTradeRequest`, `HoldRequest`, `HoldRef`. The wallet answers `UNIMPLEMENTED` until step 2                                                        |
| `market.proto` | New `MarketService.GenerateCandles(coin, day) → written`, for the backfill job; `Packages.MARKET`                                                                                                     |
| `libs/pulsar`  | `TradeExecutedMessage`, `TRADE_EXECUTED_TOPIC` (`trade-executed`), `TRADE_SIDES`                                                                                                                      |

## How it works

### Coins in `@jobber/money`

```ts
export const ASSETS = {
  USD: { scale: 2, kind: 'fiat' },
  NXC: { scale: 8, kind: 'coin' },
  BLIP: { scale: 8, kind: 'coin' },
  ORB: { scale: 8, kind: 'coin' },
  WISP: { scale: 8, kind: 'coin' },
} as const satisfies Record<string, { scale: number; kind: 'fiat' | 'coin' }>;
```

One coin is `100_000_000n` minor units. Prices stay in USD cents per whole coin, so a trade's
USD amount is `price · qty / 10^8`, rounded in the house's favour (step 3).

`formatAmount` used `Intl.NumberFormat` with `style: 'currency'`. That style accepts only
three-letter codes: `BLIP` and `WISP` would throw a `RangeError`, and `NXC` and `ORB` would format
as unknown currencies. Coins are formatted as plain decimals with the code after them instead:
`1,234,567,890.12345678 WISP`. The amount still reaches `Intl` as a decimal string, so all 8
decimals are exact.

`CoinCode` and `FiatCode` are computed from `ASSETS`. Adding a coin there updates the types,
`COINS` and the GraphQL validation.

### Coins in the wallet

The migration inserts the four coin rows into `assets`. A ledger test now checks that every
`ASSETS` entry exists in the table with the same scale, so adding a coin in one place and
forgetting the other fails a test.

Two wallet behaviours had to be decided before trading exists, because adding coins to `ASSETS`
would otherwise change them silently:

- **`balances` used to create and list an account pair for every asset.** With coins, every
  user would get four `0.00000000` coin rows on the Wallet page before ever trading. Now only fiat
  accounts are created on first read. A coin is listed once its accounts exist, and the first
  trade will create them (step 2). The rows keep `ASSETS` order: USD first.
- **`transfer` accepted any asset.** Coins could then have been gifted between users. That
  breaks `positions` (step 2), which computes average cost from trades. A gifted coin has no
  cost, so the recipient's P/L would be wrong. `TransferInput` now validates
  `@IsIn(FIAT)`, and the service checks `isFiat` as a second guard.

`Credit` over gRPC still takes any asset. It is the dev and test faucet, and the tests above use
it to give a user coins.

### Trading RPCs

```proto
rpc SettleTrade(SettleTradeRequest) returns (PostingResult);   // tradeId = the market's order id
rpc PlaceHold(HoldRequest) returns (PostingResult);            // holdId = the limit order's id
rpc ReleaseHold(HoldRef) returns (PostingResult);
```

All three return the existing `PostingResult { transactionId, duplicate }`, and the proto comment
makes the retry rule part of the contract: the id is the ledger `externalRef`, so a repeat posts
nothing and returns `duplicate: true`. Insufficient funds answer `FAILED_PRECONDITION` with
nothing written; the market turns that into a `REJECTED` order.

Amounts are `int64`: `qty` in coin minor units, `usdAmount` and `fee` in cents. The market sends
the amounts it already rounded. The wallet doesn't recompute prices: it only checks that the legs
balance, and its triggers enforce that anyway.

The wallet's controller implements `WalletServiceController`, so adding the methods to the proto
forced the class to have them. Until step 2 they throw `RpcException(UNIMPLEMENTED)`. That is the
code gRPC itself uses for a method a server doesn't have, so a caller reads it the same way.

### `GenerateCandles`

`BackfillCandles` (step 6) will have one item per coin-day. The executor calls
`GenerateCandles({ coin, day: '2026-11-20' })`, and the market writes 1,440 one-minute candles
from its seeded random walk. The upsert on `(coin, interval, start)` makes a redelivered message
harmless, which job consumers must be.

### `TradeExecutedMessage`

```ts
{ tradeId, transactionId, userId, coin, side: 'BUY' | 'SELL', qty: "150000000", usdAmount: "4237", fee: "22" }
```

Amounts are decimal strings, as on every wire in this project. `coin` is checked by shape only
(`^[A-Z]{2,10}$`), not against `COINS`. Phase 3 showed why: importing `@jobber/money` from
`libs/pulsar` brings bigint literals into the `jobs` and `executor` builds, which target ES2015.
The wallet writes the message from the same transaction as the posting, so the coin is valid by
construction. `fee` may be `"0"`; `qty` and `usdAmount` may not.

## How it was verified

- **`npx nx test money`** (103 tests): coins parse with 8 decimals (`"0.00000001"` → `1n`), a
  ninth decimal is refused rather than rounded, coins format as `1.50000000 NXC` (grouping and
  sign included), `COINS` / `FIAT` / `isCoin` / `isFiat` agree with `ASSETS`. Every asset,
  coins included, survives `parseAmount(toDecimal(x))` and `fromWire(toWire(x))`.
- **`npx nx test pulsar`:** `TradeExecutedMessage` accepts a valid trade and a zero fee. It
  rejects non-UUID ids, a zero `userId`, a lowercase coin, an unknown side, a numeric or zero
  `qty`, a decimal `usdAmount` and a negative fee, each as a `NonRetryableError`.
- **`npx nx test wallet`** (66 tests, Testcontainers PostgreSQL with all migrations): the
  `assets` table holds every `ASSETS` code with its scale. A coin transfer is refused by
  validation (`asset must be one of the following values: USD`). A user credited with ORB sees
  USD then ORB in `balances`, and a new user still sees only USD. `SettleTrade`, `PlaceHold` and
  `ReleaseHold` answer `UNIMPLEMENTED`. The existing transfer, top-up and concurrency tests are
  unchanged and pass.
- **Generated code:** regenerating in the Linux container changed only `wallet.ts` and added
  `market.ts`. The other three generated files came out identical.
- `npx nx affected -t lint test build`: green for 13 projects (no new lint warnings).

## Lessons

- **Adding to a shared list changes every place that iterates it.** `Object.keys(ASSETS)` was
  already used for "every asset a user has" and "every asset you may transfer". Those two meant
  "every fiat currency" without saying so. Giving assets a `kind` made each caller state which
  one it meant.
