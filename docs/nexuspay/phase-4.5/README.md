# Phase 4.5 — step by step

Phase 4.5 adds four real coins, BTC, ETH, HYPE and ZEC, priced from public exchange data next to
the four simulated ones. Trading doesn't change: paper money against the simulated market maker,
with the same quotes, fees, holds and orders. Prices come from Coinbase Exchange, with Binance as
the fallback per coin. The plan is the "4.5 Real prices" tab of the
[spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko). Work is committed straight to `main`.

| Step                         | Delivers                                                                                                                      | Doc                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1. Contracts                 | BTC, ETH, HYPE, ZEC in `libs/money` and the wallet's `assets`; a price source per coin in the market; `source` on price ticks | [01-contracts.md](01-contracts.md) |
| 2. Providers                 | Coinbase and Binance adapters (WebSocket prices, REST candles), fake servers for tests                                        |                                    |
| 3. Rate provider, live ticks | Per-coin failover and failback, bad print guard, live ticks on the leader; tests 2–6                                          |                                    |
| 4. History                   | `GenerateCandles` for live coins from exchange candles, the last 24 h filled on leadership; test 8                            |                                    |
| 5. React, e2e, docs          | Real and simulated groups, source badge, "Price unavailable"; Playwright; the live check; docs audit; tests 1, 7, 9, 10       |                                    |
