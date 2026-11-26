import { useSyncExternalStore } from 'react';

import { Button } from './button';

export interface Toast {
  id: number;
  message: string;
}

/** Notifications that come from outside a page (a fill arriving on the user feed). */
class Toasts {
  private items: Toast[] = [];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  get current(): Toast[] {
    return this.items;
  }

  show(message: string, durationMs = 6_000): void {
    const toast = { id: this.nextId++, message };
    this.items = [...this.items, toast].slice(-4);
    this.emit();
    setTimeout(() => this.dismiss(toast.id), durationMs);
  }

  dismiss(id: number): void {
    const next = this.items.filter((t) => t.id !== id);
    if (next.length !== this.items.length) {
      this.items = next;
      this.emit();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export const toasts = new Toasts();

export function Toaster() {
  const items = useSyncExternalStore(
    (listener) => toasts.subscribe(listener),
    () => toasts.current,
  );
  return (
    <div
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
    >
      {items.map((toast) => (
        <div
          key={toast.id}
          role="status"
          data-testid="toast"
          className="flex items-start justify-between gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm text-white shadow-lg"
        >
          <p>{toast.message}</p>
          <Button
            variant="ghost"
            className="-my-1 h-7 px-2 text-slate-300 hover:bg-slate-800 hover:text-white"
            aria-label="Dismiss"
            onClick={() => toasts.dismiss(toast.id)}
          >
            ×
          </Button>
        </div>
      ))}
    </div>
  );
}
