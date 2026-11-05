/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nxReadySignal } from '@nx/vite/plugins/nx-ready-signal.plugin';

// Relative `/api/*` calls are proxied to the backends with the `/api` prefix stripped (as
// `apps/ui-admin/proxy.conf.json` does for Angular), so the browser sees one origin and the HttpOnly
// `Authentication` cookie set by `auth` is sent with every request.
const api = (target: string) => ({
  target,
  changeOrigin: true,
  rewrite: (path: string) => path.replace(/^\/api/, ''),
});

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/nexus',
  server: {
    port: 4300,
    host: 'localhost',
    proxy: {
      '/api/auth': api('http://localhost:3000'),
    },
  },
  preview: {
    port: 4300,
    host: 'localhost',
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [react(), tailwindcss(), nxReadySignal()],
  build: {
    outDir: '../../dist/apps/nexus',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  test: {
    name: 'nexus',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/nexus',
      provider: 'v8' as const,
    },
  },
}));
