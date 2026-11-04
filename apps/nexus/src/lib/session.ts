import { useSyncExternalStore } from 'react';

export interface User {
  id: string;
  email: string;
}

const STORAGE_KEY = 'nexus.user';

/**
 * Client-side record of the logged-in user, mirroring the Angular `Session` in `apps/ui`.
 *
 * The JWT lives in an HttpOnly cookie that scripts cannot read, and `auth` exposes no
 * "current user" query, so the app remembers the user returned by `login` instead. The backend
 * remains the source of truth: a FORBIDDEN response from a guarded service should clear this.
 */
class Session {
  private user: User | null = readStoredUser();
  private readonly listeners = new Set<() => void>();

  get = (): User | null => this.user;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(user: User): void {
    this.user = user;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } catch {
      // Storage unavailable (e.g. private mode); the session just won't survive a reload.
    }
    this.emit();
  }

  clear(): void {
    this.user = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // See `set`.
    }
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const session = new Session();

/** The current user, re-rendering the caller whenever the session changes. */
export function useSession(): User | null {
  return useSyncExternalStore(session.subscribe, session.get);
}

function readStoredUser(): User | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as User) : null;
  } catch {
    return null;
  }
}
