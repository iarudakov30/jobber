import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';

import { createQueryClient } from './lib/query-client';
import { RealtimeClient, realtimeUrl } from './lib/realtime/realtime-client';
import { PriceBook, RealtimeProvider } from './lib/realtime/realtime';
import { router } from './router';

// A FORBIDDEN answer from a backend clears the session; send the person to sign in again and
// bring them back afterwards.
const queryClient = createQueryClient(() =>
  router.navigate({
    to: '/login',
    search: { returnUrl: router.state.location.href },
  }),
);

// One socket per tab; the app shell connects it while someone is signed in.
const realtime = {
  client: new RealtimeClient({ url: realtimeUrl() }),
  prices: new PriceBook(),
};

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

root.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider value={realtime}>
        <RouterProvider router={router} />
      </RealtimeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
