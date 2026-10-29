import { Injectable, computed, signal } from '@angular/core';

import { User } from './user.model';

const STORAGE_KEY = 'jobber.user';

/**
 * Client-side record of the logged-in user.
 *
 * The JWT lives in an HttpOnly cookie that scripts cannot read, and `auth` exposes no
 * "current user" query, so the UI remembers the user returned by `login` instead. The
 * backend remains the source of truth: a FORBIDDEN response clears this state.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly _user = signal<User | null>(readStoredUser());

  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  set(user: User): void {
    this._user.set(user);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } catch {
      // Storage unavailable (e.g. private mode); the session just won't survive a reload.
    }
  }

  clear(): void {
    this._user.set(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // See `set`.
    }
  }
}

function readStoredUser(): User | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as User) : null;
  } catch {
    return null;
  }
}
