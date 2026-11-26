# Step 5 — Realtime gateway

- **Where:** committed directly to `main`.

## Why

Prices change every second and balances change whenever a trade, a transfer or a top-up
commits. Polling for both would be either slow or wasteful. The browser needs one connection
that pushes:

- **the prices it watches**, to anyone signed in;
- **its own balance changes and fills**, to that user only, in every tab, whichever replica of
  the gateway each tab reached;
- **without one bad client hurting the others:** a tab that stops reading, a laptop that went to
  sleep, a replica being redeployed.

The market (step 3) and the wallet (step 2) already publish all of this to the RabbitMQ
`realtime` exchange. This step builds what sits between that exchange and the browser.

## What changed

| Area            | Change                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/realtime` | New NestJS app, HTTP 3007, no database. `gateway/`: `RealtimeGateway` (raw `ws`, upgrade, heartbeat, backpressure, shutdown), `RealtimeFeed`, `Registry`, `SocketAuth`, `protocol.ts`, `GET /realtime/stats` |
| `apps/realtime` | `load/prices-and-fills.js`: k6, acceptance test 11 (`npx nx run realtime:load-test prices-and-fills`)                                                                                                        |
| `libs/rabbitmq` | `TransientQueue`: a server-named exclusive queue whose bindings change at runtime and come back after a reconnect. `RabbitConnection.onConnect(hook)`                                                        |
| Workspace       | `realtime` in `npm start` and `npm stop`; `scripts/k6.mjs` runs any project's `load/<name>.js`                                                                                                               |

The Vite proxy (`/api/realtime`, `ws: true`) and the React client come with the screens in
step 7.

## How it works

### The upgrade: auth before the socket exists

```
GET /realtime  Upgrade: websocket  Cookie: Authentication=<jwt>  Origin: http://localhost:4300
```

The gateway is a `WebSocketServer({ noServer: true })` with no HTTP server of its own. It
listens to the `upgrade` event of Nest's server and decides before `handleUpgrade`:

| Request                                     | Answer                     |
| ------------------------------------------- | -------------------------- |
| another path                                | `404`                      |
| `Origin` not in `REALTIME_ALLOWED_ORIGINS`  | `403`                      |
| no `Authentication` cookie, or auth says no | `401`                      |
| auth doesn't answer within 3 s              | `503` (the client retries) |
| the gateway is shutting down                | `503`                      |
| otherwise                                   | `101`, the socket opens    |

A refusal is written to the raw TCP socket as `HTTP/1.1 401 Unauthorized` and the connection is
closed: no WebSocket ever exists for an unauthenticated request. The cookie is checked with
auth's gRPC `Authenticate`, as `GqlAuthGuard` does.

The `Origin` check matters because the browser sends the cookie with a WebSocket handshake to
any site that asks. Without it a page elsewhere could open a socket as the user and read their
balances. A request without `Origin` (not a browser: tests, k6) is let through; it still needs a
valid cookie.

### The protocol

JSON text frames. The client sends two requests:

```json
{ "op": "subscribe", "channel": "prices.NXC" }
{ "op": "unsubscribe", "channel": "prices.NXC" }
```

The gateway sends:

```json
{ "type": "welcome", "userId": 19, "channels": ["user.19"] }
{ "type": "subscribed", "channel": "prices.NXC" }
{ "type": "message", "channel": "prices.NXC", "seq": 812, "data": { "type": "price", ... } }
{ "type": "message", "channel": "user.19", "seq": 337, "data": { "type": "fill", ... } }
{ "type": "error", "code": "FORBIDDEN", "message": "...", "channel": "user.7" }
{ "type": "resync" }
```

- Each socket joins its own `user.<id>` automatically. Subscribing to any `user.*` channel, its
  own included, is `FORBIDDEN`. The public channels are the four `prices.<coin>`; anything else
  is `UNKNOWN_CHANNEL`. A malformed request is `BAD_REQUEST`. None of these close the socket.
- A frame over 1 KB closes it with 1009: no request is that big.
- `seq` is the price's per-coin counter (step 3) or, on a user channel, the wallet's outbox id
  taken from the `messageId` (`outbox-wallet-<id>`). It only increases but may skip numbers. A
  client drops what isn't newer than what it has, comparing balance messages per asset (step 2).
  A message without a usable `seq` isn't forwarded.
- `welcome` is sent only once RabbitMQ has the user's binding. A client that fetches its
  snapshot after `welcome` can't miss a change committed after that fetch.

### One queue per instance, bindings per user

```
realtime (topic) ──prices.*──────────▶ amq.gen-… (exclusive, auto-delete) ──▶ gateway a
                 ──user.19, user.42──▶
                 ──prices.*──────────▶ amq.gen-… ──▶ gateway b
                 ──user.19───────────▶
```

Each gateway instance declares one server-named, exclusive, auto-delete queue (`TransientQueue`
in `libs/rabbitmq`). It is bound to `prices.*` for its whole life, and to `user.<id>` from that
user's first socket on the instance until their last one closes (`Registry` counts them). A
message's routing key is its channel; the gateway serializes the frame once and sends that string
to every socket on the channel.

A user with tabs on two replicas has the binding on both queues, so both get every message
(acceptance test 9). The queue is consumed without acks: these messages are disposable, and the
queue drops the oldest beyond 10,000.

If the connection to RabbitMQ drops, the queue goes with it, and messages published meanwhile
are lost. On reconnect `TransientQueue` declares a new queue and binds every key it remembers.
The gateway then sends `{"type":"resync"}` to every socket, so clients refetch their snapshots.

### A client that stops reading

`ws.bufferedAmount` is what the gateway has accepted for a socket but the network hasn't taken:

- **Over 1 MB:** price messages to that socket are dropped. The next tick replaces them anyway.
  User messages are never dropped.
- **Over 4 MB for 10 s:** the socket is closed with 1013 ("try again later") and leaves the
  registry at once, so nothing more is queued for it. Its client isn't reading, so the close
  frame waits behind the backlog; `ws` destroys the connection if the close doesn't complete in
  30 s.

A check every second looks at every socket.

### Heartbeat and shutdown

A ping every 25 s; a socket that missed two pongs in a row is terminated. That's a laptop that
went to sleep or a connection a NAT forgot, found within about a minute.

On SIGTERM the gateway stops accepting upgrades (503) and closes every socket with 1012 ("service
restart"). Clients reconnect at once, to another replica, instead of waiting for a timeout. It
gives them a second to answer, then cuts the rest off.

### `GET /realtime/stats`

Sockets, users, channels, the queue's bindings, counters (received, delivered, dropped prices,
closed for being slow, terminated for missing pongs) and memory (heap, rss). No user data.

## How it was verified

- **`gateway.api.spec.ts`** (12 tests): replicas of the real app against a Testcontainers
  RabbitMQ, with real `ws` clients. Only `auth` is faked. The test publishes to `realtime` the
  way the market (prices) and the wallet's outbox (user messages, `outbox-wallet-<id>`) do.
  RabbitMQ's management API shows the bindings.
  - **Acceptance test 8:**
    - no cookie, a forged one, or another cookie gives 401, with no socket created;
    - a foreign `Origin` gives 403, another path 404, auth down 503;
    - `welcome` names the user's own channel; subscribing to `user.1` or to its own channel is
      `FORBIDDEN`; another user's message never arrives;
    - malformed, unknown and binary requests get an error and the socket stays open; a 2 KB frame
      closes it with 1009.
  - **Prices:**
    - subscribers get ticks with the tick's `seq`, non-subscribers nothing, and nothing after
      `unsubscribe`;
    - a message without a `seq` isn't forwarded.
  - **Acceptance test 9:**
    - a user with two tabs on replica a and one on b: all three get the fill with its outbox
      `seq`, another user gets nothing;
    - `user.<id>` is bound once per replica;
    - after the last tab on a closes, only b's binding remains, and b still gets messages; after
      b's tab closes, none remain.
  - **Heartbeat:** a client that doesn't answer pings (`autoPong: false`) is terminated after two
    missed pongs; one that answers stays.
  - **Acceptance test 12:** thresholds lowered to 64 KB / 256 KB / 1 s. A client stops reading
    while 32 KB user messages pile up for it. Its price ticks are dropped, then it is closed. The
    other client on the same channel gets every tick, in order, and stays open. When the slow
    client reads again it finds its backlog, fewer ticks than were sent, and then the 1013.
  - **RabbitMQ drops every connection** (`rabbitmqctl close_all_connections`): clients get
    `resync`, then user messages and prices again, without reconnecting.
  - **Shutdown:** both sockets close with 1012; the port refuses afterwards.
  - `/realtime/stats`.
- **`protocol.spec.ts`, `registry.spec.ts`:** request parsing, every refusal, `seq` from the body
  or the `messageId`, cookie parsing; first and last socket per user, channel membership.
- **`libs/rabbitmq`:** `TransientQueue` binds and unbinds at runtime. After
  `close_all_connections` it reports `reconnected`, has a new queue with the same bindings, and
  the old queue is gone.
- **By hand** against the real `auth`, `wallet`, `market` and `realtime`: alice connected,
  subscribed to `prices.NXC` and got one tick a second with consecutive `seq`. Then she bought
  0.1 NXC through the market. The socket got two `balance` messages (USD 8018 → 7594 cents, NXC
  0.7) and the `fill` with the order id, `seq` 334, 335 and 337. Without a cookie the upgrade got 401.
- **Acceptance test 11** (k6 in Docker, `npx nx run realtime:load-test prices-and-fills`, against
  the services above, run from their built bundles): 1,000 sockets for 5 minutes, connecting at
  random moments in the first 22 s, while 960 market buys were placed (4 a second, by 20
  users).
  - **All 1,000 sockets connected** on the first attempt (median 11 ms, p95 521 ms).
  - **No user message lost:** after the run each socket asked the market for its user's FILLED
    orders, and every one of them had arrived on that socket as a `fill`: 1,000 of 1,000
    complete, 0 missing. 144,045 user messages and 1,147,992 price ticks were delivered; no
    price was dropped.
  - **Memory flat:** sampled every 5 s with 1,000 sockets open, heap stayed between 40 and 57 MB
    and rss between 117 and 119 MB from the first minute to the last.
- `npx nx test realtime`: 21 tests. `npx nx test rabbitmq`: 18. `npx nx affected -t lint build`:
  green for 21 projects, every build printed `webpack compiled successfully`;
  `npx nx affected -t test`: green for 16 projects (run two at a time: the machine was short on
  memory).

## Lessons

- **A thousand clients that connect in the same millisecond fail before they reach the code.**
  The first full run started all 1,000 k6 clients at once. 275 got a refused connection: the
  operating system's queue of not-yet-accepted connections (200 on client Windows, 511 by
  default in Node) overflowed before the gateway saw them. The end of that run repeated it, with
  725 clients asking the market for their orders in the same instant. Real clients don't arrive
  that way, except after an outage, and that's exactly why step 7's client reconnects with a
  random delay (1 s to 30 s, with jitter). The load test now connects its clients at random
  moments and retries like a client would, counting the retries (there were none).

- **A gateway that's fair to everyone has to give up on someone.** Without a limit, one tab that
  stopped reading makes the process hold every message for it, until memory runs out for all
  the others. Dropping that socket's prices (they're replaced every second anyway) and then
  closing it is the price of keeping everyone else's feed fast. User messages are never dropped,
  so a slow socket is closed rather than sent an incomplete history.
- **Answer the handshake, not the socket.** Checking the cookie after the WebSocket is open would
  mean accepting a connection, then sending an error and closing it. Every scanner on the
  internet would get a socket for a moment. Doing it in `upgrade` turns them away with a plain
  401 before any of the gateway's state exists.
- **"Connected" and "listening" are two different moments.** The socket is open as soon as
  the handshake ends, but the user's messages only reach this instance once RabbitMQ has the
  `user.<id>` binding. A client that fetched its balances on `open` could read them just before
  a trade committed and miss the trade's message, because the binding came a few milliseconds
  later. Sending `welcome` after the binding, and having clients fetch on `welcome`, closes
  that gap.
