// Gives test users money in the wallet, from the `seed` system account (the dev faucet).
//
//   npx nx run wallet:seed                                    # alice@ and bob@example.com, $100 each
//   npx nx run wallet:seed --args="test@example.com=25.50"    # any users, any USD amounts
//
// Needs auth (3000/5000) and wallet (5003) running. A missing user is created through auth's
// GraphQL with the password `Test@1234`. Each user is seeded at most once (externalRef
// `seed:<userId>`); running it again changes nothing. Nx loads apps/wallet/.env, so the gRPC
// addresses come from there.
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

const PASSWORD = 'Test@1234';
const AUTH_GRAPHQL =
  process.env.AUTH_GRAPHQL_URL ?? 'http://localhost:3000/auth';
const AUTH_GRPC = process.env.AUTH_GRPC_SERVICE_URL ?? 'localhost:5000';
const WALLET_GRPC = process.env.WALLET_GRPC_SERVICE_URL ?? 'localhost:5003';

const proto = (name) =>
  fileURLToPath(
    new URL(`../libs/grpc/src/lib/proto/${name}.proto`, import.meta.url),
  );

function client(file, pkg, service, url) {
  // longs: String, like every service here (GRPC_LOADER_OPTIONS): int64 amounts stay exact.
  const definition = protoLoader.loadSync(proto(file), { longs: String });
  const Client = grpc.loadPackageDefinition(definition)[pkg][service];
  return new Client(url, grpc.credentials.createInsecure());
}

const call = (stub, method, request) =>
  new Promise((resolve, reject) =>
    stub[method](request, (error, response) =>
      error ? reject(error) : resolve(response),
    ),
  );

/** "100" → "10000", "25.5" → "2550": USD dollars to cents, as the wire's decimal string. */
function cents(dollars) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(dollars);
  if (!match) {
    throw new Error(`"${dollars}" is not a USD amount like 100 or 25.50`);
  }
  return (
    BigInt(match[1]) * 100n +
    BigInt((match[2] ?? '').padEnd(2, '0'))
  ).toString();
}

async function createUser(email) {
  const response = await fetch(AUTH_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `mutation ($input: CreateUserInput!) { createUser(createUserInput: $input) { id } }`,
      variables: { input: { email, password: PASSWORD } },
    }),
  });
  const { errors } = await response.json();
  if (errors?.length) {
    throw new Error(
      `Creating ${email} failed: ${errors.map((e) => e.message).join('; ')}`,
    );
  }
}

async function findOrCreateUser(auth, email) {
  try {
    return {
      user: await call(auth, 'FindUserByEmail', { email }),
      created: false,
    };
  } catch (error) {
    if (error.code !== grpc.status.NOT_FOUND) throw error;
  }
  await createUser(email);
  return {
    user: await call(auth, 'FindUserByEmail', { email }),
    created: true,
  };
}

const targets = (
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['alice@example.com=100', 'bob@example.com=100']
).map((arg) => {
  const [email, dollars = '100'] = arg.split('=');
  return { email, amount: cents(dollars), dollars };
});

const auth = client('auth', 'auth', 'AuthService', AUTH_GRPC);
const wallet = client('wallet', 'wallet', 'WalletService', WALLET_GRPC);
try {
  for (const { email, amount, dollars } of targets) {
    const { user, created } = await findOrCreateUser(auth, email);
    const result = await call(wallet, 'Credit', {
      userId: user.id,
      asset: 'USD',
      amount,
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `seed:${user.id}`,
    });
    console.log(
      `${email} (user ${user.id}${created ? `, created with password ${PASSWORD}` : ''}): ` +
        (result.duplicate
          ? 'already seeded, unchanged'
          : `credited $${dollars}`),
    );
  }
} catch (error) {
  console.error(`Seeding failed: ${error.details ?? error.message}`);
  console.error('Are auth (3000, 5000) and wallet (5003) running?');
  process.exitCode = 1;
} finally {
  auth.close();
  wallet.close();
}
