import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';

import { E2eUser, E2eUsers, USERS_ENV } from './users';

const AUTH_URL = process.env['AUTH_URL'] ?? 'http://localhost:3000/auth';
const WALLET_GRPC = process.env['WALLET_GRPC'] ?? 'localhost:5003';
const PASSWORD = 'Test@1234';

/**
 * Creates two fresh users through auth's GraphQL and gives the sender $100.00 through the
 * wallet's gRPC Credit (from the `seed` system account), so every run starts from known
 * balances whatever earlier runs left behind.
 */
export default async function globalSetup(): Promise<void> {
  const run = `${Date.now()}`;
  const sender = await createUser(`e2e-${run}-sender@example.com`);
  const recipient = await createUser(`e2e-${run}-recipient@example.com`);
  await credit(sender.id, '10000', `e2e-seed:${sender.id}`);
  process.env[USERS_ENV] = JSON.stringify({
    sender,
    recipient,
  } satisfies E2eUsers);
}

async function createUser(email: string): Promise<E2eUser> {
  let response: Response;
  try {
    response = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query:
          'mutation ($i: CreateUserInput!) { createUser(createUserInput: $i) { id } }',
        variables: { i: { email, password: PASSWORD } },
      }),
    });
  } catch (error) {
    throw new Error(`auth isn't reachable at ${AUTH_URL}: ${error}`, {
      cause: error,
    });
  }
  const body = await response.json();
  const id = Number(body?.data?.createUser?.id);
  if (!id) {
    throw new Error(`createUser failed: ${JSON.stringify(body)}`);
  }
  return { id, email, password: PASSWORD };
}

function credit(userId: number, amount: string, externalRef: string) {
  const definition = protoLoader.loadSync(
    join(__dirname, '../../../libs/grpc/src/lib/proto/wallet.proto'),
    { longs: String },
  );
  const WalletService = (
    grpc.loadPackageDefinition(definition) as unknown as {
      wallet: { WalletService: typeof grpc.Client };
    }
  ).wallet.WalletService;
  const client = new WalletService(
    WALLET_GRPC,
    grpc.credentials.createInsecure(),
  ) as grpc.Client & {
    Credit: (
      request: object,
      callback: (error: grpc.ServiceError | null) => void,
    ) => void;
  };
  return new Promise<void>((resolve, reject) =>
    client.Credit(
      {
        userId,
        asset: 'USD',
        amount,
        fromSystemAccount: 'seed',
        type: 'seed',
        externalRef,
      },
      (error) => {
        client.close();
        if (error) {
          reject(
            new Error(
              `wallet Credit failed (is wallet running on ${WALLET_GRPC}?): ${error.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    ),
  );
}
