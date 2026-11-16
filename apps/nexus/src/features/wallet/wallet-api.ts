import { graphql } from '../../gql/wallet';
import type {
  BalancesQuery,
  EntriesQuery,
  TransferMutation,
} from '../../gql/wallet/graphql';
import { walletClient } from '../../lib/graphql';

export type Balance = BalancesQuery['balances'][number];
export type EntryPage = EntriesQuery['entries'];
export type LedgerEntry = EntryPage['items'][number];
export type Transfer = TransferMutation['transfer'];

const BALANCES = graphql(`
  query Balances {
    balances {
      asset
      available
      held
    }
  }
`);

const ENTRIES = graphql(`
  query Entries($after: ID, $first: Int) {
    entries(after: $after, first: $first) {
      items {
        id
        transactionId
        type
        asset
        amount
        createdAt
      }
      nextCursor
    }
  }
`);

const TRANSFER = graphql(`
  mutation Transfer($input: TransferInput!) {
    transfer(input: $input) {
      transactionId
      amount
      asset
    }
  }
`);

/** Query keys: invalidate `walletKeys.all` after a transfer to refresh balances and history. */
export const walletKeys = {
  all: ['wallet'] as const,
  balances: ['wallet', 'balances'] as const,
  entries: ['wallet', 'entries'] as const,
};

export const HISTORY_PAGE_SIZE = 20;

export async function fetchBalances(): Promise<Balance[]> {
  return (await walletClient.request(BALANCES)).balances;
}

export async function fetchEntries(after: string | null): Promise<EntryPage> {
  return (
    await walletClient.request(ENTRIES, { after, first: HISTORY_PAGE_SIZE })
  ).entries;
}

/**
 * Sends a transfer. `idempotencyKey` identifies this transfer: sending it again with the same
 * key and input (a retry after a timeout) can't move the money twice.
 */
export async function sendTransfer(
  input: { toEmail: string; asset: string; amount: string },
  idempotencyKey: string,
): Promise<Transfer> {
  const { transfer } = await walletClient.request(
    TRANSFER,
    { input },
    { 'Idempotency-Key': idempotencyKey },
  );
  return transfer;
}
