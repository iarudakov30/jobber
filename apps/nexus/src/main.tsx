import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';

import { createQueryClient } from './lib/query-client';
import { router } from './router';

// A FORBIDDEN answer from a backend clears the session; send the person to sign in again and
// bring them back afterwards.
const queryClient = createQueryClient(() =>
  router.navigate({
    to: '/login',
    search: { returnUrl: router.state.location.href },
  }),
);

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

root.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
