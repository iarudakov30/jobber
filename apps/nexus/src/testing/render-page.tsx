import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import type { ComponentType } from 'react';

import { type Realtime, RealtimeProvider } from '../lib/realtime/realtime';

/** The wallet API as the browser sees it in tests (jsdom's origin + the proxied path). */
export const WALLET_URL = 'http://localhost:3000/api/wallet';
export const PAYMENTS_URL = 'http://localhost:3000/api/payments';
export const MARKET_URL = 'http://localhost:3000/api/market';

/** An MSW server for one spec file: `onUnhandledRequest: 'error'` catches unexpected calls. */
export function mockServer() {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

/**
 * Renders a page under a minimal router (it uses `Link`) and a fresh, retry-free QueryClient.
 * `realtime` (from `fakeRealtime()`) replaces the idle realtime client, which never connects.
 */
export async function renderPage(
  Page: ComponentType,
  { realtime }: { realtime?: Realtime } = {},
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: Page,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  // Resolve the route first, so the page is on screen when this returns.
  await router.load();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = <RouterProvider router={router as never} />;
  render(
    <QueryClientProvider client={queryClient}>
      {realtime ? (
        <RealtimeProvider value={realtime}>{page}</RealtimeProvider>
      ) : (
        page
      )}
    </QueryClientProvider>,
  );
  return { queryClient };
}
