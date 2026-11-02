# React app with Login and Register

- **Branch:** `feature/nexus-react-app` (commit `d57b258`), from `main`. It is independent of the
  backend stack.
- **Spec:** phase 1 (moved here from phase 2, so React runs from week one).

## Why

NexusPay needs its own frontend, and learning React was one of the goals. The Angular `ui` app
stays the jobber jobs console; NexusPay screens are React only. Starting with login means the app
talks to a real backend (the existing `auth` service) from day one.

## What changed

| Area | Change |
| ---- | ------ |
| `apps/nexus` (new) | React 19 + Vite app on port 4300, generated with `@nx/react` |
| Stack | TanStack Router (code-based routes), TanStack Query, `graphql-request`, React Hook Form + Zod, Tailwind CSS v4 |
| Screens | Login, Register, a protected home page, an app shell with a "Simulated market · no real money" banner |
| Root | `@nx/react` and `@nx/vite` 24.0.2; `nexus` added to `npm start`, `npm stop`, `npm run build` |
| `nx.json` | The new Vite, Vitest and TypeScript plugins are scoped to `apps/nexus/**` |

Files worth reading:

| File | Role |
| ---- | ---- |
| `apps/nexus/src/router.tsx` | Routes; `beforeLoad` redirects; `safeReturnUrl()` |
| `apps/nexus/src/lib/session.ts` | Who is logged in, kept in `localStorage`, exposed via `useSyncExternalStore` |
| `apps/nexus/src/lib/errors.ts` | `errorMessages()` and `applyServerErrors()`: GraphQL errors → form fields |
| `apps/nexus/src/features/auth/*` | `login`/`register` API calls and the two forms |
| `apps/nexus/vite.config.mts` | Dev proxy `/api/auth` → `localhost:3000`, Tailwind plugin |

## How it works

- **Same-origin cookie.** The browser calls `/api/auth`; Vite proxies it to `auth` with `/api`
  stripped (exactly like `apps/ui/proxy.conf.json`). `auth` sets the HttpOnly `Authentication`
  cookie, which the browser then sends automatically.
- **Session.** JavaScript can't read the HttpOnly cookie, and `auth` has no "current user" query,
  so the app remembers the user that `login` returned (a copy of the Angular `Session`). The backend
  stays the source of truth. A small store plus `useSyncExternalStore` re-renders components when it
  changes, with no state library.
- **Routing.** Protected routes throw `redirect({ to: '/login', search: { returnUrl } })` in
  `beforeLoad`. `safeReturnUrl()` only accepts same-app paths (`/x`, not `//evil.com` or
  `https://…`), so the login page can't be used as an open redirect.
- **Server errors on fields.** NestJS validation errors arrive as
  `extensions.originalError.message` (a string or an array). Messages that start with a field
  name ("password is not strong enough") go on that field, and everything else goes on the form.
- **Sign out** only clears the client session. `auth` has no logout mutation, so the cookie
  lives until it expires.

## How it was verified

- 18 Vitest tests (session, error mapping, redirect safety, login form), lint, typecheck and a
  production build.
- Against the real `auth` service through the Vite proxy: register a user; log in (HTTP 200, the
  `Set-Cookie: Authentication=…; HttpOnly` header is present); a wrong password returns "Credentials
  are not valid"; a weak password returns "password is not strong enough" in the shape the field
  mapping expects.

## Lessons

- The Nx generator put React into the **root** `package.json` and registered plugins that scan
  every project. The deps were moved to `apps/nexus/package.json` and the plugins scoped with
  `include: ["apps/nexus/**/*"]`.
- `eslint-plugin-react` 7 crashes on ESLint 10 while auto-detecting the React version; pinning
  `settings.react.version` avoids that code path.
- `beforeEach(() => vi.mocked(fn).mockReset())` returns the mock, and Vitest then calls it as a
  teardown hook. Always use a braced body.
