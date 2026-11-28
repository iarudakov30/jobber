# Step 5 — React, e2e and the live check

- **Where:** committed directly to `main`.

## Why

Steps 1–4 put real prices into the market. This step shows them in the app and checks the whole
phase against its acceptance tests:

- the Markets page tells real coins from simulated ones and says which exchange a real price
  comes from, and when that is the fallback;
- a coin without a recent price says "Price unavailable" and can't be quoted, instead of showing
  a number nobody can trade at;
- a BTC trade works end to end exactly like an NXC one;
- the live prices match the exchange, the tests stay offline, and nothing else regressed.

## What changed

| Area                                                              | Change                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| market `Coin.providers` (`market.models.ts`, `market.service.ts`) | A live coin's exchanges in preference order (`MARKET_PRICE_PROVIDERS`), empty for a simulated coin; `PriceTick.source`'s description no longer calls Binance the fallback |
| nexus `features/market/price-status.tsx`                          | `STALE_PRICE_MS` (10 s, the market's rule), `useNow()`, `isPriceAvailable(tick, now)`, `sourceLabel(coin, tick)`, `SourceBadge`                                           |
| nexus `lib/realtime/realtime.tsx`                                 | `PriceTick.source`, from every tick and from the `coins` snapshot                                                                                                         |
| nexus `markets-page.tsx`                                          | Two cards, "Real prices" and "Simulated"; a badge per real coin; "Price unavailable" (no badge, no 24 h change) for a stale price                                         |
| nexus `trade-page.tsx`, `order-form.tsx`                          | The badge next to the price; without a price, "Price unavailable", no quote asked, a quote on screen dropped; limit orders still go                                       |
| nexus `market-api.ts`, `src/gql/market`                           | `coins` asks for `live`, `providers` and `tick.source`; codegen                                                                                                           |
| `apps/nexus-e2e/src/trade.spec.ts`                                | Acceptance test 7: a BTC market buy and a BTC limit order, skipped when the market has no BTC price                                                                       |

## How it works

### Which exchange, and is it the fallback

The `coins` query now returns, per live coin, `providers`: `["binance", "coinbase"]` with the
committed `.env`. Each tick carries its `source`, so the badge is
`sourceLabel(coin, tick)`: the exchange's name, plus "· fallback" when the tick's source isn't
`providers[0]`. The badge follows the ticks: a coin that fails over to Coinbase turns amber
("Coinbase · fallback") with the next tick, and back once Binance takes it again. The order of
preference stays a server setting; the app never hard-codes which exchange is the primary.

### Price unavailable

The market refuses to quote a price older than 10 s (`PRICES_UNAVAILABLE`). The app applies the
same rule to the last tick it has, `now - tick.at > 10 s`, with a clock that re-renders every
second (`useNow`): a price goes stale because nothing arrives, so waiting for a tick would never
notice. The tick's time is the server's and `now` is the browser's, so a clock that is off by
seconds shifts the moment by as much; on one machine they agree.

- **Markets:** the price cell says "Price unavailable", the 24 h change is "—", no badge.
- **Trade:** the header says "Price unavailable"; the order form shows a note, disables "Get
  quote", and drops a quote already on screen (it was for a price that is no longer there; the
  countdown doesn't re-quote either). A limit order can still be placed: the market holds the
  funds and fills it once prices are back, as test 5 showed in step 3.
- **Portfolio** is unchanged: it values positions at the last price it has.

This applies to every coin. A simulated coin goes stale only when no replica leads.

## How it was verified

- **nexus unit tests** (`npx nx test nexus`, 15 files, 91 tests):
  - Markets: the two groups and their rows, "Binance" and "Coinbase · fallback", the badge
    following a tick that changes source, "Price unavailable" for an 11-second-old price and for
    a coin with no tick, `sourceLabel` with either order of preference;
  - Trade: the badge for each source; a 30-second-old price: no badge, the note, "Get quote"
    disabled, no quote asked, a limit buy placed; a price that goes stale while the page is open
    (8 s old at the start) drops the quote on screen. Each page gets its own price book in these
    tests: the shared default one kept an earlier test's tick, which then went stale.
- **market:** `live-prices.api.spec.ts` checks `providers` (`["coinbase", "binance"]` in that
  suite, `[]` for NXC); the schema test passes with the regenerated `schema.gql`.
- **Acceptance test 7** (`npx nx run nexus-e2e:e2e`, 12 passed): against auth, wallet and market
  built from this commit (the market with `apps/market/.env`, so Binance first), the gateway and
  the dev server. BTC is under "Real prices" with NXC under "Simulated"; the trade page shows the
  badge; a 0.0001 BTC market buy is quoted, counted down, bought, toasted from the user feed, and
  both balances change without a reload; a BTC limit buy at half the price holds its amount plus
  the fee, shows under open orders, and is released on cancel. The NXC flows and test 10 pass as
  before.
- **Acceptance test 1** (by hand, the same market, a script printing deviations only, never a
  price): 10 samples over 14 s, each comparing the four live coins with Binance's REST ticker
  (`/api/v3/ticker/price`) fetched at the same moment. Each coin ticked 13 times in the window
  (once a second), the oldest tick seen was 1.9 s old, the largest deviation was 0.047% (HYPE;
  BTC 0.000%, ETH 0.013%, ZEC 0.021%) against the 0.5% allowed, source `binance` throughout.
  The plan compared with Coinbase's ticker; Binance is the primary now, and it keeps Coinbase's
  data out of the comparison.
- **Acceptance test 9:** `npx nx test market` with the step 4 guard (`src/testing/offline.ts`):
  no request to an exchange host, phase 4's tests (same seed, same ticks) included. The suite
  was not run with the network unplugged.
- **Acceptance test 10:** `npx nx affected -t lint test build --base=origin/main --parallel=2`
  over the whole phase (every commit since the last push): lint, test and build green for 21
  projects (7 min; market 14 suites / 167 tests, wallet 104, nexus 91, all the Testcontainers
  suites included; every backend build "webpack compiled successfully"). Lint warnings are only
  the existing ones in `jobs` and `executor`.

## Phase 4.5's acceptance tests

| #   | Test                                     | Where                                                                                 |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Real prices                              | By hand, this step (against Binance, not Coinbase)                                    |
| 2   | Failover on silence                      | `live-prices.api.spec.ts`, [step 3](03-live-ticks.md)                                 |
| 3   | Failover on disconnect                   | `live-prices.api.spec.ts`, step 3                                                     |
| 4   | Failback without flapping                | `live-prices.api.spec.ts`, step 3                                                     |
| 5   | Nobody healthy                           | `live-prices.api.spec.ts` (step 3); "Price unavailable" in the app, `trade-page.spec` |
| 6   | Bad print                                | `live-prices.api.spec.ts`, step 3                                                     |
| 7   | Trade a real coin                        | `apps/nexus-e2e/src/trade.spec.ts`, this step                                         |
| 8   | Real history                             | `backfill.api.spec.ts`, `live-prices.api.spec.ts`, [step 4](04-history.md)            |
| 9   | Simulated coins untouched, offline tests | `npx nx test market` with the offline guard, step 4                                   |
| 10  | No regressions                           | `npx nx affected -t lint test build`, this step                                       |

## Open

- **HYPE on Binance went quiet; fixed after this step.** While the market ran for the e2e runs
  and the live check (about 7 minutes), Binance sent no HYPE mini-ticker for over 10 s four times,
  so HYPE failed over to Coinbase each time and came back after the 30 s failback: Coinbase priced
  it for about 3 of those minutes. The mini-ticker comes only in a second with a trade. The
  provider now reads `@kline_1s`, which comes every second, trades or not
  ([02-providers.md](02-providers.md#the-two-exchanges)): the next 5 minutes against the real
  exchanges had no failover, and test 1 again showed every coin from Binance within 0.05%.
- Binance's separate API terms are still unread ([02-providers.md](02-providers.md#terms-of-use)).

## Lessons

- **Staleness needs a clock.** A price that stops arriving changes nothing on its own; the page
  has to look at the time. The same 10 s as the server keeps the app from offering a quote the
  market would refuse.
- **Shared test fixtures age.** A module-level price book carried one test's tick into the next,
  where it was suddenly too old. Give each rendered page its own.
