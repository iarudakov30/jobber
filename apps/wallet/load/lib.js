// Shared helpers for the wallet's k6 load tests (run them with `npx nx run wallet:load-test <name>`).
// They talk to the real services: auth GraphQL (users, login), wallet GraphQL (transfers,
// balances) and wallet gRPC (Credit to seed, RunAudit to check the books).
import http from 'k6/http';
import grpc from 'k6/net/grpc';
import { fail } from 'k6';

const HOST = __ENV.HOST || 'host.docker.internal';
export const AUTH_URL = __ENV.AUTH_URL || `http://${HOST}:3000/auth`;
export const WALLET_URL = __ENV.WALLET_URL || `http://${HOST}:3004/wallet`;
const WALLET_GRPC = __ENV.WALLET_GRPC || `${HOST}:5003`;

const wallet = new grpc.Client();
wallet.load(['/protos'], 'wallet.proto');
let connected = false;

function grpcCall(method, request) {
  if (!connected) {
    wallet.connect(WALLET_GRPC, { plaintext: true });
    connected = true;
  }
  const response = wallet.invoke(`wallet.WalletService/${method}`, request);
  if (response.status !== grpc.StatusOK) {
    fail(`${method} failed: ${JSON.stringify(response.error)}`);
  }
  return response.message;
}

export function gql(url, query, variables, headers) {
  return http.post(url, JSON.stringify({ query, variables }), {
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
  });
}

/** A fresh auth user with a session cookie and `dollars` in the wallet (from `seed`). */
export function newUser(label, dollars) {
  const email = `k6-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.com`;
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
  if (dollars) {
    grpcCall('Credit', {
      userId: id,
      asset: 'USD',
      amount: String(dollars * 100),
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `k6-seed:${id}`,
    });
  }
  return { id, email, cookie };
}

const TRANSFER = `mutation ($i: TransferInput!) {
  transfer(input: $i) { transactionId amount asset }
}`;

/**
 * POSTs a transfer and sorts the outcome: 'ok', or the error code (BAD_USER_INPUT for an
 * overdraft, CONFLICT, UNPROCESSABLE_ENTITY, ...), or 'http_<status>' when there's no JSON.
 */
export function transfer(from, toEmail, cents, idempotencyKey) {
  const response = gql(
    WALLET_URL,
    TRANSFER,
    { i: { toEmail, asset: 'USD', amount: String(cents) } },
    {
      cookie: `Authentication=${from.cookie}`,
      'idempotency-key': idempotencyKey,
    },
  );
  let body;
  try {
    body = response.json();
  } catch {
    return { outcome: `http_${response.status}`, response };
  }
  if (body.data && body.data.transfer) {
    return { outcome: 'ok', transfer: body.data.transfer, response };
  }
  const error = (body.errors || [])[0] || {};
  return {
    outcome: (error.extensions && error.extensions.code) || 'unknown',
    message: error.message,
    response,
  };
}

/** The user's available USD, as a minor-units string. */
export function available(user) {
  const response = gql(WALLET_URL, '{ balances { asset available } }', null, {
    cookie: `Authentication=${user.cookie}`,
  });
  return response.json('data.balances.0.available');
}

/** RunAudit's issues; [] when the books are sound. */
export function auditIssues() {
  return grpcCall('RunAudit', {}).issues || [];
}

/** A key unique to this VU and iteration. */
export function uniqueKey() {
  return `k6-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
