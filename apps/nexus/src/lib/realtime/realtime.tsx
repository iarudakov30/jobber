import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';

import {
  type ConnectionStatus,
  RealtimeClient,
  type RealtimeMessage,
} from './realtime-client';

/** A coin's latest price: USD cents per coin (a decimal string), its `seq`, epoch ms. */
export interface PriceTick {
  price: string;
  seq: number;
  at: number;
}

/**
 * The latest tick of every coin, for `useSyncExternalStore`. A tick replaces the stored one only
 * if its `seq` is higher, so a snapshot fetched over GraphQL never overwrites a newer live tick.
 */
export class PriceBook {
  private readonly ticks = new Map<string, PriceTick>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(coin: string): PriceTick | undefined {
    return this.ticks.get(coin);
  }

  set(coin: string, tick: PriceTick): void {
    const current = this.ticks.get(coin);
    if (current && current.seq >= tick.seq) {
      return;
    }
    this.ticks.set(coin, tick);
    for (const listener of [...(this.listeners.get(coin) ?? [])]) {
      listener();
    }
  }

  subscribe(coin: string, listener: () => void): () => void {
    let set = this.listeners.get(coin);
    if (!set) {
      set = new Set();
      this.listeners.set(coin, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
}

export interface Realtime {
  client: RealtimeClient;
  prices: PriceBook;
}

/** Never connects: the default for pages rendered without a provider (most tests). */
const idle: Realtime = {
  client: new RealtimeClient({
    url: 'ws://idle.invalid',
    createSocket: () => {
      throw new Error('the idle realtime client never connects');
    },
  }),
  prices: new PriceBook(),
};

const RealtimeContext = createContext<Realtime>(idle);

export function RealtimeProvider({
  value,
  children,
}: {
  value: Realtime;
  children: ReactNode;
}) {
  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): Realtime {
  return useContext(RealtimeContext);
}

/** Connected while someone is signed in; disconnected (no reconnects) after they sign out. */
export function useRealtimeConnection(signedIn: boolean): void {
  const { client } = useRealtime();
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    client.start();
    return () => client.stop();
  }, [client, signedIn]);
}

export function useConnectionStatus(): ConnectionStatus {
  const { client } = useRealtime();
  return useSyncExternalStore(
    (listener) => client.onStatus(listener),
    () => client.status,
  );
}

/** A coin's live price: subscribes to `prices.<coin>` while the component is mounted. */
export function usePrice(coin: string): PriceTick | undefined {
  const { client, prices } = useRealtime();
  useEffect(
    () =>
      client.subscribe(`prices.${coin}`, ({ seq, data }) => {
        const { price, at } = data as { price: string; at: number };
        prices.set(coin, { price, seq, at });
      }),
    [client, prices, coin],
  );
  return useSyncExternalStore(
    (listener) => prices.subscribe(coin, listener),
    () => prices.get(coin),
  );
}

/** Runs `listener` for each of the user's messages while mounted. */
export function useUserMessages(listener: (message: RealtimeMessage) => void) {
  const { client } = useRealtime();
  useEffect(() => client.onUserMessage(listener), [client, listener]);
}

/** Runs `listener` after every (re)connect and `resync`, while mounted. */
export function useResynced(listener: () => void) {
  const { client } = useRealtime();
  useEffect(() => client.onResynced(listener), [client, listener]);
}
