# Phase 4 — step by step

Phase 4 adds a fake coin market and live updates. Users buy and sell invented coins (NXC, BLIP,
ORB, WISP) at simulated prices, with market orders and limit orders that hold funds until they
fill, are cancelled or expire. A WebSocket gateway streams prices and each user's balance changes
and fills to the React app. The plan (scope, design, tasks, acceptance tests, risks) is the
"4. Market + realtime" tab of the [spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko).
Each step follows the same pattern as before: why, what changed, how it works, how it was
verified, lessons. Work is committed straight to `main`.

| Step                | Delivers                                                                                                                                                                                            | Doc                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1. Contracts        | Coin assets in `libs/money` (scale 8) and wallet's `assets`; `SettleTrade` / `PlaceHold` / `ReleaseHold` in `wallet.proto`; `market.proto` with `GenerateCandles`; `TradeExecutedMessage`           | [01-contracts.md](01-contracts.md)               |
| 2. Wallet trading   | `market_maker`, `fees` and `genesis` system accounts, inventory top-up, `holds`, the three RPCs, `positions`, realtime `balance` and `fill` messages through the outbox; spec test 4                | [02-wallet-trading.md](02-wallet-trading.md)     |
| 3. Market: prices   | `apps/market` (3006), `market` database, Redis leader lock, seeded random-walk simulator with shocks, ticks to RabbitMQ `realtime`, 1-minute candles, `coins` / `candles` / `quote`; tests 1, 2, 13 | [03-market-prices.md](03-market-prices.md)       |
| 4. Market: orders   | Market and limit orders, matching on every tick, cancel, `order.expire` through a delay bucket, `SETTLING` recovery, crash fault flag; tests 3, 5, 6, 7                                             | [04-market-orders.md](04-market-orders.md)       |
| 5. Realtime gateway | `apps/realtime` (3007): raw `ws` with cookie auth on upgrade, channel protocol, per-instance RabbitMQ queue with per-user bindings, heartbeats, backpressure, shutdown; tests 8, 9, 11, 12          | [05-realtime-gateway.md](05-realtime-gateway.md) |
| 6. Candle backfill  | `BackfillCandles` job in `jobs` (one item per coin-day) and its consumer in `executor` calling `GenerateCandles`                                                                                    |                                                  |
| 7. React            | `RealtimeClient`, `usePrice`, `useUserFeed`; Markets, Trade and Portfolio screens; the top-up return page on the user feed; Playwright trade and reconnect flows; tests 10, 14                      |                                                  |

The steps are a proposed order, not part of the spec; adjust as they're built. The spec allows
splitting the phase (market and trading first, realtime second); steps 1 to 4 are that first
half.
