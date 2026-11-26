# Step 7 — React

- **Where:** committed directly to `main`.

## Why

Steps 1 to 6 built a market, a wallet that settles its trades, and a gateway that pushes prices
and balance changes. None of it was visible. This step puts it in the React app:

- **watch prices move** (Markets), **trade** with a quote that counts down or a limit order
  (Trade), **see what you own** at live prices (Portfolio);
- **see results without reloading:** a fill, a hold, a release or a top-up changes the page as
  soon as the wallet commits it;
- **survive the connection:** a gateway that dies or restarts must cost the user a short
  "Offline", not a stale page.

## What changed

| Area                       | Change                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nexus` `lib/realtime/`    | `RealtimeClient` (ref-counted subscriptions, backoff with jitter, resubscribe, `resynced`, `seq` order), `PriceBook`, `RealtimeProvider`, `usePrice`, `useConnectionStatus` |
| `nexus` `features/market/` | Markets, Trade (`PriceChart` on `lightweight-charts`, `OrderForm`, orders, balances) and Portfolio pages; `market-api.ts`; `useUserFeed`; `bars.ts`                         |
| `nexus`                    | Routes `/markets`, `/trade/$coin`, `/portfolio`; connection indicator and toasts in the shell; the top-up page waits for the credit on the user feed; `positions` query     |
| `nexus` config             | Vite proxy `/api/market` (3006) and `/api/realtime` (3007, `ws: true`); codegen output `src/gql/market`; `lightweight-charts` 5.2.1                                         |
| `nexus-e2e`                | `trade.spec.ts` (trade flows, acceptance test 10); global setup starts the realtime gateway it may kill (`gateway.ts`), teardown stops it; a funded `trader`                |

## How it works

### One socket per tab

`main.tsx` creates one `RealtimeClient` and one `PriceBook` and provides them to the app. The
shell connects the client while someone is signed in (`useRealtimeConnection`) and closes it on
sign-out. The URL is the app's own origin, `/api/realtime`, so the HttpOnly cookie goes with the
upgrade, and Vite's dev proxy forwards it (`ws: true`) to the gateway. The browser's `Origin`,
`http://localhost:4300`, passes through and is in the gateway's `REALTIME_ALLOWED_ORIGINS`.

The client (`lib/realtime/realtime-client.ts`) has no React in it and takes its socket and
randomness from outside, so its tests play the gateway:

- **Subscriptions are ref-counted.** `subscribe('prices.NXC', listener)` sends `subscribe` for
  the first listener and `unsubscribe` after the last. While connecting it sends nothing; the
  welcome subscribes every channel that has listeners.
- **Reconnect.** After a close it waits 1 s, then 2, 4… up to 30 s, each wait randomized to
  50–100% so a thousand tabs don't return in the same millisecond (step 5's load test showed
  what that does). A gateway that closes with 1012 (restarting) is reconnected to at once,
  within a random second. A welcome resets the backoff.
- **`resynced`** fires on every welcome (the first connect too) and every `resync` frame: there
  may have been messages nobody received, so whatever shows server data refetches. The gateway
  sends the welcome only once the user's channel is bound, so a refetch started then can't
  miss a change committed after it.
- **Order.** A message whose `seq` isn't higher than the last of its kind is dropped: per price
  channel, per asset for balance messages (the wallet orders those per asset, step 2), per order
  for fills (a redelivered fill has the same `seq`).
- **Status** (`connecting`, `open`, `closed`) drives the dot in the header: Live, Connecting…,
  Offline.

### Prices

`PriceBook` keeps each coin's latest tick and tells only that coin's listeners. `usePrice(coin)`
subscribes to `prices.<coin>` while mounted and reads the book with `useSyncExternalStore`.
Pages also put the `coins` query's snapshot into the book (`useSeedPrices`), so a price shows
before the first live tick. A tick replaces the stored one only if its `seq` is higher, so a
snapshot that arrives late never overwrites a newer live price.

### The user feed

`useUserFeed()` is mounted once, in the shell:

- **`balance`** (absolute values) replaces that asset's row in the cached `balances` query, or
  adds it. Every page that shows a balance updates: Wallet, Trade, Portfolio.
- **`fill`** invalidates orders, positions and the history, and shows a toast ("Bought 0.1 NXC
  for $4.24").
- **`resynced`** invalidates everything the user owns (`['wallet']`, `['market', 'orders']`).

### Markets, Trade, Portfolio

- **Markets** (`/markets`): every coin, its live price, and the change since 24 hours ago from
  the `coins` query's `open24h`.
- **Trade** (`/trade/$coin`):
  - **Chart.** A day of 1-minute candles from `candles`; each live tick updates the last bar or
    starts the next minute's (`bars.ts`, `applyTick`). The chart (`lightweight-charts`, 163 KB)
    is a lazy chunk loaded with this page.
  - **Market orders.** "Get quote" shows the price, the fee, the total and a countdown from the
    quote's `expiresAt`; at 0 the form asks for a new quote with the same terms. "Buy NXC" places
    the order with the quote's id as its `Idempotency-Key`, so a retry of the same quote can't
    trade twice. `QUOTE_EXPIRED` gets a fresh quote and says so; `REJECTED` says why ("Not
    enough USD in your wallet.").
  - **Limit orders.** One key per side, quantity and price, kept until the order is placed, as
    `/send` does for transfers.
  - **Balances.** The coin's and USD's available and held amounts.
  - **Orders.** Open orders with Cancel, and recent ones with their status.
- **Portfolio** (`/portfolio`): the wallet's `positions` valued at live prices (rounded down to a
  cent), profit or loss against the cost basis, and cash with what limit orders hold.

### The top-up return page, on the feed

Phase 3's `TopUpStatus` polled twice: the payment until SUCCEEDED, then the wallet's `topUp`
until the credit appeared. The first wait stays a poll: `payments` has no realtime channel. The
second now listens:

- it looks for the credit once when the payment succeeds;
- it looks again on each `balance` message in the payment's currency and on each `resynced`;
- after the same 30 s it says the money "will show shortly".

Only while the socket isn't open does it poll as before, so a page without a gateway still works.

## How it was verified

- **Vitest** (`npx nx test nexus`: 85 tests, 32 new or changed):
  - **`realtime-client.spec.ts`** (fake sockets, fake timers):
    - ref-counted subscribe and unsubscribe;
    - routing to channel and user listeners;
    - out-of-order drops per channel, asset and fill;
    - the exact backoff sequence up to the 30 s cap, and its reset after a welcome;
    - 1012 within a second;
    - resubscribe and `resynced` after a reconnect;
    - `stop()` for good;
    - a replaced socket's late messages ignored;
    - `PriceBook` order.
  - **`use-user-feed.spec.tsx`:** a balance replaces or adds a row; a fill invalidates and
    toasts; a resync invalidates.
  - **`markets-page.spec.tsx`, `portfolio-page.spec.tsx`:** snapshot, then live ticks, through a
    fake gateway; value and P/L.
  - **`trade-page.spec.tsx`** (MSW):
    - the quote and its countdown, and the order placed with the quote's id as its key;
    - a re-quote at 0;
    - `QUOTE_EXPIRED` and a rejection;
    - a limit order retried with the same key;
    - input checks;
    - open orders and Cancel.
  - **`top-up-status.spec.tsx`:** the phase 3 polling tests still pass (no socket); with a live
    feed the credit is looked up again on a USD balance message, not by polling, and a feed that
    stays quiet ends in "will show shortly".
  - **`bars.spec.ts`:** candles to bars, ticks within and after a minute.
- **Playwright** (`npx nx run nexus-e2e:e2e`, against the real auth, wallet, market and gateway):
  all 10 tests passed, twice in a row.
  - **A market buy:** quote, countdown, Buy. The fill's toast and both new balances (USD and 0.1
    NXC) appear without a reload.
  - **A limit buy at $1.00:** "+ $1.01 held" appears live, and Cancel releases it.
  - **A limit buy above the price** fills on the simulator's next tick: the toast and 0.11 NXC
    arrive with no action by the page.
  - **Portfolio** shows the position valued at the live price.
  - **Acceptance test 10:**
    - the test kills the gateway the run started (SIGKILL: no 1012) under an open Trade page,
      and the indicator leaves Live;
    - while the gateway is down, the test credits $5 over gRPC; the page can't hear it and still
      shows the old balance;
    - the test starts a new gateway;
    - within 30 s of the kill (the whole test took 7 s) the page is Live again, shows the $5
      (refetched on `resynced`, no reload), and its live price moves again (resubscribed).
  - The phase 2 wallet flows pass unchanged.
- **Acceptance test 14:** `npx nx affected -t lint test build typecheck`: green for 21 projects.
  `nexus:codegen` regenerated with no difference.

## Lessons

- **Order of two lines can drop every subscription after a reconnect.** The first client
  resubscribed on welcome and only then marked itself open, and `subscribe` sends only while
  open. So after a reconnect it subscribed to nothing: no prices, silently. The fake-socket test
  that reconnects and looks at what was sent caught it before any browser did.
- **A countdown must start from when its quote arrived.** The clock started when the form
  mounted, so a fresh 10 s quote first showed "11 s". The clock now restarts in the same handler
  that stores the quote.
- **Only kill what you started.** The reconnect test needs to kill a gateway. Global setup starts
  one when port 3007 is free and records its pid; if someone's own gateway is running there, the
  test is skipped with a reason instead of killing it.
