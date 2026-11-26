import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';
import {
  GRPC_LOADER_OPTIONS,
  GrpcStatus,
  HoldRequest,
  PostingResult,
  SettleTradeRequest,
} from '@jobber/grpc';

/** Where wallet.proto lives in the source tree (the build copies it next to the bundle). */
export const WALLET_PROTO = join(
  __dirname,
  '../../../../libs/grpc/src/lib/proto/wallet.proto',
);
/** And market.proto, for the GenerateCandles tests. */
export const MARKET_PROTO = join(
  __dirname,
  '../../../../libs/grpc/src/lib/proto/market.proto',
);

export type Method = 'SettleTrade' | 'PlaceHold' | 'ReleaseHold';

/** An account in the fake ledger: a user's available or held balance, or a system account. */
export type Account =
  `user:${number}:available` | `user:${number}:held` | 'market_maker' | 'fees';

export interface Leg {
  account: Account;
  asset: string;
  amount: bigint;
}

export interface Posting {
  type: 'trade' | 'hold' | 'release';
  ref: string;
  transactionId: string;
  legs: Leg[];
  terms: string;
}

export interface Hold {
  userId: number;
  asset: string;
  amount: bigint;
  status: 'ACTIVE' | 'CAPTURED' | 'RELEASED';
}

/**
 * How the next call of a method goes wrong: `before` fails without doing anything (the wallet
 * was down), `after` does it and then fails (the answer was lost). Either way the caller sees
 * UNAVAILABLE and doesn't know which.
 */
export type Fault = 'before' | 'after';

class Refused extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The wallet's trading RPCs over real gRPC (the real `wallet.proto`, the market's real client),
 * backed by an in-memory ledger with the wallet's rules: idempotent by `tradeId` / `holdId`
 * (a repeat returns `duplicate: true`, other terms are refused), too few funds is
 * FAILED_PRECONDITION with nothing written, an unknown hold NOT_FOUND, a hold captured or
 * released only once. Every posting balances per asset. The wallet itself is tested against
 * PostgreSQL in `apps/wallet` (trading.service.spec.ts); this is the contract the market relies on.
 */
export class FakeWallet {
  readonly calls: { method: Method; request: unknown }[] = [];
  readonly postings = new Map<string, Posting>();
  readonly holds = new Map<string, Hold>();
  private readonly balances = new Map<string, bigint>();
  private readonly faults: Record<Method, Fault[]> = {
    SettleTrade: [],
    PlaceHold: [],
    ReleaseHold: [],
  };
  private nextTransaction = 1;
  private server?: grpc.Server;
  url = '';

  async start(): Promise<void> {
    const definition = protoLoader.loadSync(WALLET_PROTO, GRPC_LOADER_OPTIONS);
    const wallet = (
      grpc.loadPackageDefinition(definition) as unknown as {
        wallet: { WalletService: { service: grpc.ServiceDefinition } };
      }
    ).wallet;
    this.server = new grpc.Server();
    this.server.addService(wallet.WalletService.service, {
      SettleTrade: this.handler('SettleTrade', (r: SettleTradeRequest) =>
        this.settleTrade(r),
      ),
      PlaceHold: this.handler('PlaceHold', (r: HoldRequest) =>
        this.placeHold(r),
      ),
      ReleaseHold: this.handler('ReleaseHold', (r: { holdId: string }) =>
        this.releaseHold(r.holdId),
      ),
    });
    const port = await new Promise<number>((resolve, reject) =>
      this.server?.bindAsync(
        '127.0.0.1:0',
        grpc.ServerCredentials.createInsecure(),
        (error, bound) => (error ? reject(error) : resolve(bound)),
      ),
    );
    this.url = `127.0.0.1:${port}`;
  }

  stop(): void {
    this.server?.forceShutdown();
  }

  /** Makes the next calls of `method` fail, one fault per call. */
  fail(method: Method, ...faults: Fault[]): void {
    this.faults[method].push(...faults);
  }

  /** Gives a user funds (what a top-up or the faucet would). */
  fund(userId: number, asset: string, amount: bigint): void {
    this.add(`user:${userId}:available`, asset, amount);
  }

  balance(userId: number, asset: string): { available: bigint; held: bigint } {
    return {
      available: this.get(`user:${userId}:available`, asset),
      held: this.get(`user:${userId}:held`, asset),
    };
  }

  get(account: Account, asset: string): bigint {
    return this.balances.get(`${account}|${asset}`) ?? 0n;
  }

  postingsOf(type: Posting['type']): Posting[] {
    return [...this.postings.values()].filter((p) => p.type === type);
  }

  callsOf(method: Method): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.request);
  }

  /**
   * The books are sound: no user balance below zero, every user's `held` equals their active
   * holds, every asset sums to zero over all accounts (funding counts as a posting from
   * outside, so it is subtracted).
   */
  checkBooks(): string[] {
    const problems: string[] = [];
    const activeHeld = new Map<string, bigint>();
    for (const hold of this.holds.values()) {
      if (hold.status === 'ACTIVE') {
        const key = `user:${hold.userId}:held|${hold.asset}`;
        activeHeld.set(key, (activeHeld.get(key) ?? 0n) + hold.amount);
      }
    }
    for (const [key, value] of this.balances) {
      if (key.startsWith('user:') && value < 0n) {
        problems.push(`${key} is negative: ${value}`);
      }
      if (key.includes(':held|') && value !== (activeHeld.get(key) ?? 0n)) {
        problems.push(
          `${key} is ${value} but active holds add up to ${activeHeld.get(key) ?? 0n}`,
        );
      }
    }
    for (const posting of this.postings.values()) {
      const sums = new Map<string, bigint>();
      for (const leg of posting.legs) {
        sums.set(leg.asset, (sums.get(leg.asset) ?? 0n) + leg.amount);
      }
      for (const [asset, sum] of sums) {
        if (sum !== 0n) {
          problems.push(
            `${posting.type} ${posting.ref}: ${asset} sums to ${sum}`,
          );
        }
      }
    }
    return problems;
  }

  private handler<T>(method: Method, run: (request: T) => PostingResult) {
    return (
      call: grpc.ServerUnaryCall<T, PostingResult>,
      callback: grpc.sendUnaryData<PostingResult>,
    ) => {
      this.calls.push({ method, request: call.request });
      const fault = this.faults[method].shift();
      if (fault === 'before') {
        return callback({
          code: GrpcStatus.UNAVAILABLE,
          details: 'fake wallet: down',
        });
      }
      try {
        const result = run(call.request);
        if (fault === 'after') {
          return callback({
            code: GrpcStatus.UNAVAILABLE,
            details: 'fake wallet: answer lost',
          });
        }
        callback(null, result);
      } catch (error) {
        if (error instanceof Refused) {
          return callback({ code: error.code, details: error.message });
        }
        callback({ code: GrpcStatus.INTERNAL, details: String(error) });
      }
    };
  }

  private settleTrade(r: SettleTradeRequest): PostingResult {
    const qty = BigInt(r.qty);
    const usd = BigInt(r.usdAmount);
    const fee = BigInt(r.fee);
    if (qty <= 0n || usd <= 0n || fee < 0n || fee > usd) {
      throw new Refused(GrpcStatus.INVALID_ARGUMENT, 'bad trade amounts');
    }
    const terms = JSON.stringify({ ...r });
    const hold = r.holdId ? this.holds.get(r.holdId) : undefined;
    if (r.holdId && !hold) {
      throw new Refused(GrpcStatus.NOT_FOUND, `hold ${r.holdId} not found`);
    }
    const existing = this.postings.get(`trade:${r.tradeId}`);
    if (existing) {
      if (existing.terms !== terms) {
        throw new Refused(
          GrpcStatus.INVALID_ARGUMENT,
          'tradeId was already settled with different terms',
        );
      }
      return { transactionId: existing.transactionId, duplicate: true };
    }
    const user = (side: 'available' | 'held') =>
      `user:${r.userId}:${side}` as Account;
    const legs: Leg[] = [];
    const leg = (account: Account, asset: string, amount: bigint) => {
      if (amount !== 0n) legs.push({ account, asset, amount });
    };
    if (hold) {
      if (hold.status !== 'ACTIVE') {
        throw new Refused(
          GrpcStatus.FAILED_PRECONDITION,
          `hold ${r.holdId} is ${hold.status}`,
        );
      }
      const needed = r.side === 'BUY' ? usd + fee : qty;
      const asset = r.side === 'BUY' ? 'USD' : r.coin;
      if (
        hold.userId !== r.userId ||
        hold.asset !== asset ||
        hold.amount < needed
      ) {
        throw new Refused(
          GrpcStatus.INVALID_ARGUMENT,
          `hold ${r.holdId} doesn't cover the trade`,
        );
      }
    }
    if (r.side === 'BUY') {
      const cost = usd + fee;
      if (hold) {
        leg(user('held'), 'USD', -hold.amount);
        leg(user('available'), 'USD', hold.amount - cost);
      } else {
        leg(user('available'), 'USD', -cost);
      }
      leg('market_maker', 'USD', usd);
      leg('fees', 'USD', fee);
      leg('market_maker', r.coin, -qty);
      leg(user('available'), r.coin, qty);
    } else {
      if (hold) {
        leg(user('held'), r.coin, -hold.amount);
        leg(user('available'), r.coin, hold.amount - qty);
      } else {
        leg(user('available'), r.coin, -qty);
      }
      leg('market_maker', r.coin, qty);
      leg('market_maker', 'USD', -usd);
      leg(user('available'), 'USD', usd - fee);
      leg('fees', 'USD', fee);
    }
    const posting = this.post('trade', r.tradeId, legs, terms);
    if (hold) {
      hold.status = 'CAPTURED';
    }
    return posting;
  }

  private placeHold(r: HoldRequest): PostingResult {
    const amount = BigInt(r.amount);
    const existing = this.holds.get(r.holdId);
    if (existing) {
      if (
        existing.userId !== r.userId ||
        existing.asset !== r.asset ||
        existing.amount !== amount
      ) {
        throw new Refused(
          GrpcStatus.INVALID_ARGUMENT,
          'holdId was already used for a different hold',
        );
      }
      const posting = this.postings.get(`hold:${r.holdId}`);
      return { transactionId: posting?.transactionId ?? '', duplicate: true };
    }
    const posting = this.post('hold', r.holdId, [
      {
        account: `user:${r.userId}:available`,
        asset: r.asset,
        amount: -amount,
      },
      { account: `user:${r.userId}:held`, asset: r.asset, amount },
    ]);
    this.holds.set(r.holdId, {
      userId: r.userId,
      asset: r.asset,
      amount,
      status: 'ACTIVE',
    });
    return posting;
  }

  private releaseHold(holdId: string): PostingResult {
    const hold = this.holds.get(holdId);
    if (!hold) {
      throw new Refused(GrpcStatus.NOT_FOUND, `hold ${holdId} not found`);
    }
    if (hold.status === 'RELEASED') {
      const posting = this.postings.get(`release:${holdId}`);
      return { transactionId: posting?.transactionId ?? '', duplicate: true };
    }
    if (hold.status === 'CAPTURED') {
      throw new Refused(
        GrpcStatus.FAILED_PRECONDITION,
        `hold ${holdId} was captured by a trade`,
      );
    }
    const posting = this.post('release', holdId, [
      {
        account: `user:${hold.userId}:held`,
        asset: hold.asset,
        amount: -hold.amount,
      },
      {
        account: `user:${hold.userId}:available`,
        asset: hold.asset,
        amount: hold.amount,
      },
    ]);
    hold.status = 'RELEASED';
    return posting;
  }

  /** Applies the legs if no user balance goes negative; FAILED_PRECONDITION otherwise. */
  private post(
    type: Posting['type'],
    ref: string,
    legs: Leg[],
    terms = '',
  ): PostingResult {
    for (const leg of legs) {
      if (
        leg.account.startsWith('user:') &&
        this.get(leg.account, leg.asset) + leg.amount < 0n
      ) {
        throw new Refused(
          GrpcStatus.FAILED_PRECONDITION,
          `insufficient ${leg.asset}`,
        );
      }
    }
    for (const leg of legs) {
      this.add(leg.account, leg.asset, leg.amount);
    }
    const transactionId = String(this.nextTransaction++);
    this.postings.set(`${type}:${ref}`, {
      type,
      ref,
      transactionId,
      legs,
      terms,
    });
    return { transactionId, duplicate: false };
  }

  private add(account: Account, asset: string, amount: bigint): void {
    const key = `${account}|${asset}`;
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
  }
}
