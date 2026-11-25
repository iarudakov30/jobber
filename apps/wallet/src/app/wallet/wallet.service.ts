import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import { SQL, and, desc, eq, lt } from 'drizzle-orm';
import { firstValueFrom } from 'rxjs';
import {
  AUTH_SERVICE_NAME,
  AuthServiceClient,
  GrpcStatus,
  Packages,
  User,
} from '@jobber/grpc';
import {
  ASSETS,
  AssetCode,
  FIAT,
  isAssetCode,
  isFiat,
  toWire,
} from '@jobber/money';
import { canonicalJson as canonical } from '@jobber/idempotency';
import { OutboxRelay } from '@jobber/outbox';
import { DATABASE_CONNECTION } from '../database/database-connection';
import {
  LedgerDatabase,
  LedgerService,
  PostingResult,
} from '../ledger/ledger.service';
import { accounts, entries, transactions } from '../ledger/schema';
import { WalletInputError } from './wallet.errors';

/** Published (through the outbox) after every transfer. No consumer yet. */
export const TRANSFER_COMPLETED_TOPIC = 'transfer-completed';

export interface TransferCompletedEvent {
  transactionId: string;
  fromUserId: number;
  toUserId: number;
  asset: string;
  /** Minor units, as a decimal string. */
  amount: string;
}

export interface UserBalance {
  asset: string;
  available: bigint;
  held: bigint;
}

export interface EntryRow {
  id: string;
  transactionId: string;
  type: string;
  asset: string;
  amount: bigint;
  createdAt: Date;
}

export interface CreditInput {
  userId: number;
  asset: string;
  amount: bigint;
  fromSystemAccount: string;
  type: string;
  externalRef: string;
}

export const MAX_PAGE_SIZE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * System accounts `Credit` may draw from. `seed` is the dev faucet (`wallet:seed`), refused in
 * production; `stripe_clearing` is for phase 3 top-ups.
 */
function creditSources(): string[] {
  return process.env['NODE_ENV'] === 'production'
    ? ['stripe_clearing']
    : ['seed', 'stripe_clearing'];
}

@Injectable()
export class WalletService implements OnModuleInit {
  private auth: AuthServiceClient;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: LedgerDatabase,
    private readonly ledger: LedgerService,
    private readonly relay: OutboxRelay,
    @Inject(Packages.AUTH) private readonly authClient: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.auth =
      this.authClient.getService<AuthServiceClient>(AUTH_SERVICE_NAME);
  }

  /**
   * One row per fiat currency (a new user's accounts are created on this first read), then one
   * per coin the user has accounts for. Coin accounts arrive with the first trade, so someone who
   * never traded sees no zero coin rows.
   */
  async balances(userId: number): Promise<UserBalance[]> {
    const ownerId = String(userId);
    const read = () =>
      this.db
        .select({
          asset: accounts.asset,
          kind: accounts.kind,
          balance: accounts.balance,
        })
        .from(accounts)
        .where(
          and(eq(accounts.ownerType, 'user'), eq(accounts.ownerId, ownerId)),
        );

    let rows = await read();
    const missing = FIAT.filter(
      (asset) => rows.filter((r) => r.asset === asset).length < 2,
    );
    if (missing.length) {
      await Promise.all(
        missing.map((asset) => this.ledger.ensureAccounts(userId, asset)),
      );
      rows = await read();
    }

    const owned = new Set(rows.map((r) => r.asset));
    const assets = (Object.keys(ASSETS) as AssetCode[]).filter(
      (asset) => isFiat(asset) || owned.has(asset),
    );
    return assets.map((asset) => {
      const of = (kind: string) =>
        rows.find((r) => r.asset === asset && r.kind === kind)?.balance ?? 0n;
      return { asset, available: of('available'), held: of('held') };
    });
  }

  /** The user's entries, newest first, `first` at a time after the cursor `after`. */
  async entries(
    userId: number,
    options: { asset?: string | null; after?: string | null; first?: number },
  ): Promise<{ items: EntryRow[]; nextCursor: string | null }> {
    const first = options.first ?? 50;
    if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE_SIZE) {
      throw new WalletInputError(
        `first must be between 1 and ${MAX_PAGE_SIZE}`,
      );
    }
    if (options.after != null && !/^[1-9]\d{0,18}$/.test(options.after)) {
      throw new WalletInputError('after must be a cursor from nextCursor');
    }

    const conditions = [
      eq(accounts.ownerType, 'user'),
      eq(accounts.ownerId, String(userId)),
    ];
    if (options.asset) {
      conditions.push(eq(entries.asset, options.asset));
    }
    if (options.after != null) {
      conditions.push(lt(entries.id, BigInt(options.after)));
    }

    const rows = await this.userEntries(conditions)
      .orderBy(desc(entries.id))
      .limit(first + 1);

    const items = rows
      .slice(0, first)
      .map((r) => ({ ...r, id: r.id.toString() }));
    return {
      items,
      nextCursor: rows.length > first ? items[items.length - 1].id : null,
    };
  }

  /**
   * The user's entry for a Stripe top-up (`type 'topup'`, `externalRef = paymentId`), or null
   * until the wallet has credited it. `payments` reports SUCCEEDED before the credit, which
   * arrives through Pulsar, so the app polls this to know when the balance has the money.
   */
  async topUp(userId: number, paymentId: string): Promise<EntryRow | null> {
    if (!UUID.test(paymentId)) {
      throw new WalletInputError('paymentId must be a payment id (a UUID)');
    }
    const [row] = await this.userEntries([
      eq(accounts.ownerType, 'user'),
      eq(accounts.ownerId, String(userId)),
      eq(transactions.type, 'topup'),
      eq(transactions.externalRef, paymentId.toLowerCase()),
    ]).limit(1);
    return row ? { ...row, id: row.id.toString() } : null;
  }

  private userEntries(conditions: SQL[]) {
    return this.db
      .select({
        id: entries.id,
        transactionId: entries.transactionId,
        type: transactions.type,
        asset: entries.asset,
        amount: entries.amount,
        createdAt: entries.createdAt,
      })
      .from(entries)
      .innerJoin(accounts, eq(accounts.id, entries.accountId))
      .innerJoin(transactions, eq(transactions.id, entries.transactionId))
      .where(and(...conditions))
      .$dynamic();
  }

  /**
   * Moves `amount` from `from`'s available balance to the user with `toEmail`, and announces it
   * on `transfer-completed`.
   *
   * The ledger `externalRef` is `transfer:<userId>:<idempotencyKey>`, so running the same keyed
   * request twice (a retry that took over an expired claim after a crash) posts once and returns
   * the first transfer. Reusing a key for a different transfer is refused.
   */
  async transfer(
    from: User,
    input: { toEmail: string; asset: string; amount: bigint },
    idempotencyKey?: string,
  ): Promise<{ transactionId: string; asset: string; amount: bigint }> {
    const { asset, amount } = input;
    // Coins move only through trades: a gift of coins would have no cost basis in `positions`.
    if (!isFiat(asset)) {
      throw new WalletInputError(`asset ${asset} is not supported`);
    }
    if (amount <= 0n) {
      throw new WalletInputError('amount must be positive');
    }
    const recipient = await this.findUser(input.toEmail.trim());
    if (!recipient) {
      throw new WalletInputError('toEmail does not belong to any user');
    }
    if (recipient.id === from.id) {
      throw new WalletInputError('toEmail is your own email');
    }

    const [source, target] = await Promise.all([
      this.ledger.ensureAccounts(from.id, asset),
      this.ledger.ensureAccounts(recipient.id, asset),
    ]);
    const terms = {
      fromUserId: from.id,
      toUserId: recipient.id,
      asset,
      amount: toWire(amount),
    };
    const { transactionId, duplicate } = await this.ledger.post({
      type: 'transfer',
      externalRef: `transfer:${from.id}:${idempotencyKey ?? randomUUID()}`,
      legs: [
        { accountId: source.available, asset, amount: -amount },
        { accountId: target.available, asset, amount },
      ],
      metadata: terms,
      outbox: (transactionId) => [
        {
          transport: 'pulsar',
          destination: TRANSFER_COMPLETED_TOPIC,
          key: transactionId,
          payload: {
            transactionId,
            fromUserId: from.id,
            toUserId: recipient.id,
            asset,
            amount: toWire(amount),
          } satisfies TransferCompletedEvent,
        },
      ],
    });
    if (duplicate) {
      const [original] = await this.db
        .select({ metadata: transactions.metadata })
        .from(transactions)
        .where(eq(transactions.id, transactionId));
      if (canonical(original?.metadata) !== canonical(terms)) {
        throw new WalletInputError(
          'Idempotency-Key was already used for a different transfer',
        );
      }
    } else {
      this.relay.poke();
    }
    return { transactionId, asset, amount };
  }

  /** Moves money from a system account to a user's available balance (gRPC `Credit`). */
  async credit(input: CreditInput): Promise<PostingResult> {
    const { userId, asset, amount, fromSystemAccount, type, externalRef } =
      input;
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new WalletInputError('userId must be a positive integer');
    }
    if (!isAssetCode(asset)) {
      throw new WalletInputError(`asset ${asset} is not supported`);
    }
    if (amount <= 0n) {
      throw new WalletInputError('amount must be positive');
    }
    if (!creditSources().includes(fromSystemAccount)) {
      throw new WalletInputError(
        `fromSystemAccount must be one of: ${creditSources().join(', ')}`,
      );
    }
    if (!type || !externalRef) {
      throw new WalletInputError('type and externalRef are required');
    }

    const [system, user] = await Promise.all([
      this.ledger.ensureSystemAccount(fromSystemAccount, asset),
      this.ledger.ensureAccounts(userId, asset),
    ]);
    return this.ledger.post({
      type,
      externalRef,
      legs: [
        { accountId: system, asset, amount: -amount },
        { accountId: user.available, asset, amount },
      ],
      metadata: { fromSystemAccount, toUserId: userId },
    });
  }

  private async findUser(email: string): Promise<User | null> {
    try {
      return await firstValueFrom(this.auth.findUserByEmail({ email }));
    } catch (error) {
      if ((error as { code?: number }).code === GrpcStatus.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }
}
