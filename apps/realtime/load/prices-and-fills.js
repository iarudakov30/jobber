// Spec acceptance test 11: 1,000 WebSocket clients on the price channels for 5 minutes while
// users trade. No user message may be lost, and the gateway's memory must stay flat.
//
//   npx nx run realtime:load-test prices-and-fills                       # the spec's run
//   npx nx run realtime:load-test prices-and-fills -e DURATION=90s -e LISTENERS=200
//
// Needs auth (3000, gRPC 5000), wallet (3004, gRPC 5003), market (3006, simulator leading) and
// realtime (3007) running, with RabbitMQ.
//
// - setup: USERS fresh users with $100 each (auth createUser + login, wallet Credit over gRPC).
// - listeners: LISTENERS sockets, each signed in as one of the users (round robin), subscribed to
//   all four price channels, open until the end of the run. Each records the fills of its user.
//   Like real clients they don't all connect in the same millisecond: each starts at a random
//   moment in the first RAMP / 2 s, and retries a failed connect after 1-3 s (counted in
//   ws_connect_retries). A burst of 1,000 simultaneous connects overflows the listen backlog
//   (200 on client Windows) whatever the server does.
// - traders: from RAMP s on, TRADE_RATE market buys a second (quote, then placeOrder) by random
//   users, until SETTLE s before the end, so the last fills reach every socket before it closes.
// - at the end each listener asks the market for its user's FILLED orders: every one of them
//   must have arrived as a `fill` on that socket (`fills_complete` rate == 1).
// - sampler: GET /realtime/stats every 5 s (heap, rss, sockets).
import http from 'k6/http';
import grpc from 'k6/net/grpc';
import ws from 'k6/ws';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const HOST = __ENV.HOST || 'host.docker.internal';
const AUTH_URL = `http://${HOST}:3000/auth`;
const MARKET_URL = `http://${HOST}:3006/market`;
const REALTIME_URL = `ws://${HOST}:3007/realtime`;
const STATS_URL = `http://${HOST}:3007/realtime/stats`;
const WALLET_GRPC = `${HOST}:5003`;

const LISTENERS = Number(__ENV.LISTENERS || 1000);
const USERS = Number(__ENV.USERS || 20);
const DURATION_S = seconds(__ENV.DURATION || '5m');
const RAMP_S = Number(__ENV.RAMP || 45);
const SETTLE_S = Number(__ENV.SETTLE || 15);
const TRADE_RATE = Number(__ENV.TRADE_RATE || 4);
const COINS = ['NXC', 'BLIP', 'ORB', 'WISP'];

const connected = new Rate('ws_connected');
const connectRetries = new Counter('ws_connect_retries');
const fillChecksFailed = new Counter('fill_checks_failed');
const connectMs = new Trend('ws_connect_ms', true);
const prices = new Counter('prices_received');
const userMessages = new Counter('user_messages_received');
const fillsComplete = new Rate('fills_complete');
const fillsMissing = new Counter('fills_missing');
const tradesOk = new Counter('trades_ok');
const tradesFailed = new Counter('trades_failed');
const heapMb = new Trend('gateway_heap_mb');
const rssMb = new Trend('gateway_rss_mb');
const sockets = new Trend('gateway_sockets');

export const options = {
  setupTimeout: '5m',
  scenarios: {
    listeners: {
      executor: 'per-vu-iterations',
      exec: 'listen',
      vus: LISTENERS,
      iterations: 1,
      maxDuration: `${DURATION_S + 120}s`,
    },
    traders: {
      executor: 'constant-arrival-rate',
      exec: 'trade',
      rate: TRADE_RATE,
      timeUnit: '1s',
      startTime: `${RAMP_S}s`,
      duration: `${DURATION_S - RAMP_S - SETTLE_S}s`,
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
    sampler: {
      executor: 'constant-vus',
      exec: 'sample',
      vus: 1,
      duration: `${DURATION_S}s`,
    },
  },
  thresholds: {
    ws_connected: ['rate==1'],
    fills_complete: ['rate==1'],
    fills_missing: ['count==0'],
    fill_checks_failed: ['count==0'],
    trades_failed: ['count==0'],
    trades_ok: ['count>0'],
    prices_received: ['count>0'],
  },
};

// ---- setup: users with money ----------------------------------------------------------------

const wallet = new grpc.Client();
wallet.load(['/protos'], 'wallet.proto');

function gql(url, query, variables, headers) {
  return http.post(url, JSON.stringify({ query, variables }), {
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
  });
}

function newUser(i) {
  const email = `k6-rt-${i}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.com`;
  const password = 'Test@1234';
  const created = gql(
    AUTH_URL,
    'mutation ($i: CreateUserInput!) { createUser(createUserInput: $i) { id } }',
    { i: { email, password } },
  );
  const id = Number(created.json('data.createUser.id'));
  if (!id) fail(`createUser failed: ${created.body}`);
  const login = gql(
    AUTH_URL,
    'mutation ($i: LoginInput!) { login(loginInput: $i) { id } }',
    { i: { email, password } },
  );
  const cookie =
    login.cookies.Authentication && login.cookies.Authentication[0].value;
  if (!cookie) fail(`login failed: ${login.body}`);
  const credited = wallet.invoke('wallet.WalletService/Credit', {
    userId: id,
    asset: 'USD',
    amount: '10000',
    fromSystemAccount: 'seed',
    type: 'seed',
    externalRef: `k6-rt-seed:${id}`,
  });
  if (credited.status !== grpc.StatusOK) {
    fail(`Credit failed: ${JSON.stringify(credited.error)}`);
  }
  return { id, cookie };
}

export function setup() {
  const stats = http.get(STATS_URL);
  if (stats.status !== 200) fail(`realtime isn't running: ${stats.status}`);
  wallet.connect(WALLET_GRPC, { plaintext: true });
  const users = [];
  for (let i = 0; i < USERS; i++) {
    users.push(newUser(i));
  }
  wallet.close();
  return { users, start: Date.now() };
}

// ---- listeners ------------------------------------------------------------------------------

export function listen({ users, start }) {
  const user = users[(__VU - 1) % users.length];
  const end = start + DURATION_S * 1000;
  const fills = {};
  // Spread over the first half of the ramp; retries still finish before trading starts.
  sleep(Math.random() * (RAMP_S / 2));

  let response;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) {
      connectRetries.add(1);
      sleep(1 + Math.random() * 2);
    }
    const opened = Date.now();
    response = ws.connect(
      REALTIME_URL,
      { headers: { Cookie: `Authentication=${user.cookie}` } },
      (socket) => {
        socket.on('open', () => {
          connectMs.add(Date.now() - opened);
          for (const coin of COINS) {
            socket.send(
              JSON.stringify({ op: 'subscribe', channel: `prices.${coin}` }),
            );
          }
        });
        socket.on('message', (text) => {
          const frame = JSON.parse(text);
          if (frame.type !== 'message') return;
          if (frame.channel.startsWith('prices.')) {
            prices.add(1);
            return;
          }
          userMessages.add(1);
          if (frame.data.type === 'fill') {
            fills[frame.data.orderId] = true;
          }
        });
        socket.on('error', (e) => console.error(`socket error: ${e.error()}`));
        socket.setTimeout(
          () => socket.close(),
          Math.max(end - Date.now(), 1000),
        );
      },
    );
    if (response && response.status === 101) break;
  }
  connected.add(response && response.status === 101);
  if (!response || response.status !== 101) {
    console.error(`upgrade failed 5 times: ${response && response.status}`);
    return;
  }

  // Every order of this user the market filled must have reached this socket as a fill. The
  // listeners all stop at the same moment, so they ask at random moments over 10 s.
  sleep(Math.random() * 10);
  let filled;
  for (let attempt = 1; attempt <= 3 && !filled; attempt++) {
    const orders = gql(
      MARKET_URL,
      '{ orders(status: [FILLED], first: 100) { id } }',
      null,
      { cookie: `Authentication=${user.cookie}` },
    );
    filled = orders.status === 200 ? orders.json('data.orders') : undefined;
    if (!filled) sleep(1 + Math.random() * 2);
  }
  if (!filled) {
    fillChecksFailed.add(1);
    return;
  }
  if (filled.length === 100)
    fail('more than 100 fills per user: lower TRADE_RATE');
  const missing = filled.filter((o) => !fills[o.id]).length;
  fillsMissing.add(missing);
  fillsComplete.add(missing === 0);
}

// ---- traders --------------------------------------------------------------------------------

export function trade({ users }) {
  const user = users[Math.floor(Math.random() * users.length)];
  const headers = { cookie: `Authentication=${user.cookie}` };
  const coin = COINS[Math.floor(Math.random() * COINS.length)];
  const quote = gql(
    MARKET_URL,
    'mutation ($c: String!) { quote(coin: $c, side: BUY, qty: "1000000") { id } }',
    { c: coin },
    headers,
  );
  const quoteId = quote.status === 200 ? quote.json('data.quote.id') : null;
  if (!quoteId) {
    tradesFailed.add(1);
    console.error(`quote failed: ${quote.body}`);
    return;
  }
  const placed = gql(
    MARKET_URL,
    'mutation ($i: PlaceOrderInput!) { placeOrder(input: $i) { id status } }',
    { i: { type: 'MARKET', quoteId } },
    Object.assign(
      { 'idempotency-key': `k6-${__VU}-${__ITER}-${Date.now()}` },
      headers,
    ),
  );
  const ok =
    placed.status === 200 && placed.json('data.placeOrder.status') === 'FILLED';
  check(placed, { 'order filled': () => ok });
  if (ok) {
    tradesOk.add(1);
  } else {
    tradesFailed.add(1);
    console.error(`placeOrder failed: ${placed.body}`);
  }
}

// ---- the gateway's memory -------------------------------------------------------------------

export function sample() {
  const response = http.get(STATS_URL);
  if (response.status === 200) {
    const stats = response.json();
    heapMb.add(stats.memory.heapUsedMb);
    rssMb.add(stats.memory.rssMb);
    sockets.add(stats.sockets);
    console.log(
      `gateway: ${stats.sockets} sockets, heap ${stats.memory.heapUsedMb} MB, rss ${stats.memory.rssMb} MB, delivered ${stats.delivered}, dropped ${stats.droppedPrices}`,
    );
  }
  sleep(5);
}

function seconds(text) {
  const match = /^(\d+)(s|m)?$/.exec(text);
  if (!match) fail(`DURATION must look like 300s or 5m, got ${text}`);
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1);
}
