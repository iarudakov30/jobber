import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DATABASE_CONNECTION } from '../database/database-connection';
import {
  InsufficientFundsError,
  InvalidPostingError,
  isConstraintViolation,
} from './ledger.errors';
import * as schema from './schema';
import { accounts, entries, transactions } from './schema';

export type LedgerDatabase = NodePgDatabase<typeof schema>;

export interface PostingLeg {
  accountId: bigint;
  asset: string;
  /** Signed minor units: negative debits the account, positive credits it. Never 0. */
  amount: bigint;
}

export interface PostingInput {
  /** Kind of posting: 'seed', 'transfer', 'topup', ... */
  type: string;
  /** The caller's business id. Posting the same (type, externalRef) again changes nothing. */
  externalRef: string;
  legs: PostingLeg[];
  metadata?: Record<string, unknown>;
}

export interface PostingResult {
  transactionId: string;
  /** True when (type, externalRef) was already posted; nothing new was written. */
  duplicate: boolean;
}

export interface UserAccounts {
  available: bigint;
  held: bigint;
}

@Injectable()
export class LedgerService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: LedgerDatabase,
  ) {}

  /**
   * Posts one balanced journal transaction, exactly once per (type, externalRef).
   *
   * Throws `InvalidPostingError` for a malformed posting and `InsufficientFundsError` when a
   * user account would go negative; in both cases nothing is written, so the same
   * externalRef can be posted again later.
   */
  async post(input: PostingInput): Promise<PostingResult> {
    validate(input);

    return this.db.transaction(async (tx) => {
      // The unique (type, external_ref) makes the posting idempotent. A concurrent post of the
      // same ref waits here until the first one commits or rolls back.
      const [created] = await tx
        .insert(transactions)
        .values({
          type: input.type,
          externalRef: input.externalRef,
          metadata: input.metadata ?? {},
        })
        .onConflictDoNothing({
          target: [transactions.type, transactions.externalRef],
        })
        .returning({ id: transactions.id });

      if (!created) {
        const [existing] = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              eq(transactions.type, input.type),
              eq(transactions.externalRef, input.externalRef),
            ),
          );
        return { transactionId: existing.id, duplicate: true };
      }

      // Net change per account, applied (and locked) in ascending id order: two postings that
      // touch the same accounts always lock them in the same order, so they can't deadlock.
      const deltas = new Map<bigint, bigint>();
      for (const leg of input.legs) {
        deltas.set(
          leg.accountId,
          (deltas.get(leg.accountId) ?? 0n) + leg.amount,
        );
      }
      const accountIds = [...deltas.keys()].sort(compareBigint);

      const locked = await tx
        .select({ id: accounts.id, asset: accounts.asset })
        .from(accounts)
        .where(inArray(accounts.id, accountIds))
        .orderBy(asc(accounts.id))
        .for('update');
      const assetOf = new Map(locked.map((a) => [a.id, a.asset]));
      for (const leg of input.legs) {
        const asset = assetOf.get(leg.accountId);
        if (asset === undefined) {
          throw new InvalidPostingError(`Unknown account ${leg.accountId}`);
        }
        if (asset !== leg.asset) {
          throw new InvalidPostingError(
            `Account ${leg.accountId} holds ${asset}, not ${leg.asset}`,
          );
        }
      }

      for (const accountId of accountIds) {
        const delta = deltas.get(accountId) ?? 0n;
        if (delta === 0n) continue;
        try {
          await tx
            .update(accounts)
            .set({ balance: sql`${accounts.balance} + ${delta}` })
            .where(eq(accounts.id, accountId));
        } catch (error) {
          if (isConstraintViolation(error, 'user_balance_non_negative')) {
            throw new InsufficientFundsError(accountId);
          }
          throw error;
        }
      }

      await tx.insert(entries).values(
        input.legs.map((leg) => ({
          transactionId: created.id,
          accountId: leg.accountId,
          asset: leg.asset,
          amount: leg.amount,
        })),
      );

      // The deferred entries_balanced trigger re-checks the sums at COMMIT.
      return { transactionId: created.id, duplicate: false };
    });
  }

  /** The user's `available` and `held` accounts for `asset`, created on first use. */
  async ensureAccounts(
    userId: string | number,
    asset: string,
  ): Promise<UserAccounts> {
    const ownerId = String(userId);
    const rows = await this.ensure('user', ownerId, asset, [
      'available',
      'held',
    ]);
    return {
      available: rows.get('available') as bigint,
      held: rows.get('held') as bigint,
    };
  }

  /** A system account ('seed', 'stripe_clearing', 'fees', ...), created on first use. */
  async ensureSystemAccount(name: string, asset: string): Promise<bigint> {
    const rows = await this.ensure('system', name, asset, ['system']);
    return rows.get('system') as bigint;
  }

  private async ensure(
    ownerType: 'user' | 'system',
    ownerId: string,
    asset: string,
    kinds: string[],
  ): Promise<Map<string, bigint>> {
    await this.db
      .insert(accounts)
      .values(kinds.map((kind) => ({ ownerType, ownerId, asset, kind })))
      .onConflictDoNothing({
        target: [
          accounts.ownerType,
          accounts.ownerId,
          accounts.asset,
          accounts.kind,
        ],
      });
    const rows = await this.db
      .select({ id: accounts.id, kind: accounts.kind })
      .from(accounts)
      .where(
        and(
          eq(accounts.ownerType, ownerType),
          eq(accounts.ownerId, ownerId),
          eq(accounts.asset, asset),
          inArray(accounts.kind, kinds),
        ),
      );
    return new Map(rows.map((r) => [r.kind, r.id]));
  }
}

function validate({ type, externalRef, legs }: PostingInput): void {
  if (!type || !externalRef) {
    throw new InvalidPostingError('type and externalRef are required');
  }
  if (legs.length < 2) {
    throw new InvalidPostingError('A posting needs at least two legs');
  }
  const sums = new Map<string, bigint>();
  for (const leg of legs) {
    if (typeof leg.amount !== 'bigint' || leg.amount === 0n) {
      throw new InvalidPostingError('Every leg needs a non-zero bigint amount');
    }
    sums.set(leg.asset, (sums.get(leg.asset) ?? 0n) + leg.amount);
  }
  for (const [asset, sum] of sums) {
    if (sum !== 0n) {
      throw new InvalidPostingError(`Legs in ${asset} sum to ${sum}, not 0`);
    }
  }
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
