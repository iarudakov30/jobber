# How the `apps/nexus` React app works

A walkthrough of the NexusPay frontend: what lives where, how the pieces connect, and why each one
is built the way it is. It is written for someone learning React; if you know Angular, the
parallels with the Angular app `apps/ui-admin` along the way should help. How the app was created
and verified is in [phase-1/00-react-app.md](phase-1/00-react-app.md).

---

## 1. What happens when you open http://localhost:4300

```
index.html
  └─ <script type="module" src="/src/main.tsx">       ← entry point
       main.tsx
         └─ <StrictMode>
              └─ <QueryClientProvider>                  ← server-data cache
                   └─ <RouterProvider router={router}>  ← router
                        router.tsx: rootRoute → AppShell (header + <Outlet/>)
                                      ├─ "/"         → HomePage      (signed-in users only)
                                      ├─ "/login"    → LoginPage     (guests only)
                                      └─ "/register" → RegisterPage  (guests only)
```

**The chain:**

1. Vite serves [index.html](../../apps/nexus/index.html). Unlike in Angular, Vite's `index.html`
   is the real entry point: Vite sees `<script type="module" src="/src/main.tsx">` in it and
   compiles TypeScript and JSX on the fly.
2. [main.tsx](../../apps/nexus/src/main.tsx) finds `<div id="root">` and renders the component
   tree into it.
3. The router reads the URL, runs the route guards (`beforeLoad`) and renders the matching page
   inside `AppShell`.

To run it: `npx nx serve nexus`. Logging in also needs `auth` (`npx nx serve auth`) and Postgres
(`docker compose up -d postgres`).

---

## 2. Folder structure and what each folder is for

```
apps/nexus/
├── index.html              Vite entry point
├── vite.config.mts         dev server, backend proxy, Tailwind, test settings
├── package.json            this app's own dependencies (a repo rule)
├── project.json            almost empty: Nx infers serve/build/test from vite.config
├── tsconfig*.json          TypeScript: app and tests configured separately
└── src/
    ├── main.tsx            wires the app together: providers + router
    ├── router.tsx          every route and its guard
    ├── styles.css          one Tailwind line + the base background
    ├── lib/                logic without UI (testable without React)
    │   ├── session.ts      who is signed in
    │   ├── graphql.ts      HTTP client for the backend
    │   ├── errors.ts       turns server errors into form messages
    │   └── cn.ts           joins CSS class names
    ├── components/         reusable components that know nothing about business logic
    │   ├── app-shell.tsx   page frame: header + a slot for the page
    │   └── ui/             building blocks: Button, Input, Field
    └── features/           one folder per feature, everything for it side by side
        ├── auth/           API calls, forms, the login card
        └── home/           the home page
```

**Why this shape.** It's organised by feature (feature folders). When the wallet arrives in phase
2, it gets a `features/wallet/` folder with its own `wallet-api.ts`, forms and pages, and nothing
existing needs to change. Dependencies point one way only: `features` → `components` → `lib`,
never back.

---

## 3. Each layer in detail

### 3.1 Vite: [vite.config.mts](../../apps/nexus/vite.config.mts)

```ts
proxy: { '/api/auth': api('http://localhost:3000') }   // /api/auth → localhost:3000/auth
```

This is the most important line in the config. The browser calls `localhost:4300/api/auth`; Vite
forwards the request to `auth` (3000) and strips the `/api` prefix.

**Why:** `auth` puts the JWT in an HttpOnly cookie. If the frontend called `:3000` directly, that
would be a different origin, and cookies plus CORS would get painful. With the proxy the browser
sees a single site and the cookie just works. It's the same thing `apps/ui-admin/proxy.conf.json`
does for Angular.

Also in the config:

- `plugins: [react(), tailwindcss()]` — JSX support and Fast Refresh (the page updates without
  losing state), plus Tailwind.
- the `test` block — Vitest reuses this config, and tests run in `jsdom` (a browser emulated in
  Node).

### 3.2 The root: [main.tsx](../../apps/nexus/src/main.tsx)

```tsx
root.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

- **`StrictMode`** is a development-only mode. It deliberately renders components twice and runs
  effects twice to catch "impure" code: side effects in a component body, a forgotten
  unsubscribe. If you see a `console.log` twice in dev, this is why — it's not a bug.
- **A provider (`*Provider`)** is the counterpart of `providers: [...]` in Angular. React has no
  DI; it has Context instead: a provider puts a value "into the tree" and any descendant reads it
  with a hook (`useQueryClient()`, `useRouter()`).
- **`QueryClient`** (TanStack Query) is the server-data cache. It's barely used yet; in phase 2 it
  becomes central: balances, transaction history.

### 3.3 Routing: [router.tsx](../../apps/nexus/src/router.tsx)

The app uses TanStack Router rather than the more popular React Router. The main reason is **type
safety**: `<Link to="/logn">` with a typo won't compile, and search params are typed.

```tsx
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ location }) => {
    if (!session.get()) {
      throw redirect({ to: '/login', search: { returnUrl: location.href } });
    }
  },
  component: HomePage,
});
```

| Concept | What it does | Angular counterpart |
| --- | --- | --- |
| `rootRoute` with `component: AppShell` | Shared frame for every page | `AppComponent` with `<router-outlet>` |
| `<Outlet />` in AppShell | Where the current page renders | `<router-outlet>` |
| `beforeLoad` + `throw redirect(...)` | Route guard: keeps guests off `/` | `canActivate` guard |
| `validateSearch` | Parses and types `?returnUrl=...` | reading `queryParamMap` by hand |
| `declare module ... Register` | Tells TypeScript about the route tree, which powers autocomplete | — |

**Subtle points:**

- `beforeLoad` calls `session.get()`, not the `useSession()` hook. Hooks may be called **only
  inside components**, and `beforeLoad` is a plain function outside React.
- `safeReturnUrl` prevents an open redirect. Without it, a link like
  `/login?returnUrl=https://evil.com` would send the user to someone else's site after login.
  Only paths starting with a single `/` are allowed.
- After login the app uses `router.history.push(...)`, not `router.navigate(...)`: `returnUrl`
  is an arbitrary string, not a typed route.

### 3.4 The frame: [app-shell.tsx](../../apps/nexus/src/components/app-shell.tsx)

A header with the user's email and a "Sign out" button, and `<Outlet />` below it.

**An important caveat:** `auth` has no logout mutation, so "signing out" only forgets the user on
the client. The cookie stays until it expires. The code comment says so.

### 3.5 Who is signed in: [session.ts](../../apps/nexus/src/lib/session.ts)

This is the most interesting part from a React point of view.

**The problem:** the JWT is in an HttpOnly cookie that JavaScript can't read, and `auth` has no
"current user" query. So the app remembers the user returned by `login` in `localStorage`. The
`Session` in the Angular app `ui-admin` works the same way.

**How it's built:** a plain TS class (a store) plus a hook that bridges it into React:

```ts
class Session {
  private user = readStoredUser();
  private listeners = new Set<() => void>();
  get = () => this.user;                         // the state "snapshot"
  subscribe = (listener) => { ...; return unsubscribe; };
  set(user) { this.user = user; localStorage...; this.emit(); }
  clear()   { ...; this.emit(); }
}

export function useSession() {
  return useSyncExternalStore(session.subscribe, session.get);
}
```

- **`useSyncExternalStore`** is React's official hook for subscribing to an external data source —
  anything that lives outside React. React calls `subscribe`, and on every `emit()` it re-reads
  `get()` and re-renders the component if the value changed. It's the closest thing to a service
  holding a signal in Angular.
- **Why not `useState` or Context:**
  - The session is also read outside components (`beforeLoad` in the router, `login()` in the
    API).
  - `useState` only lives inside a component.
  - Context would need a provider, and it isn't reachable outside React either.
  - An external store covers both.
- **Why `get = () => ...` is an arrow-function field:** the method is passed as a callback
  (`useSyncExternalStore(session.subscribe, session.get)`). A regular method would lose `this`;
  an arrow function is bound to the instance for good.
- **The snapshot rule:** `get()` must return **the same reference** while the data hasn't changed.
  It returns `this.user`, which is correct. If it returned `{...this.user}`, React would re-render
  forever.
- **`try/catch` around `localStorage`:** in a private browser window it can throw; the session
  then simply doesn't survive a reload.

### 3.6 Talking to the backend: [graphql.ts](../../apps/nexus/src/lib/graphql.ts) and [auth-api.ts](../../apps/nexus/src/features/auth/auth-api.ts)

```ts
export const authClient = graphqlClient('/api/auth');   // credentials: 'include' → the cookie goes with each request

export async function login(credentials) {
  const { login: user } = await authClient.request(LOGIN, { loginInput: credentials });
  session.set(user);   // remember the user
  return user;
}
```

- **`graphql-request` instead of Apollo** (which the Angular app uses). It's just `fetch` for
  GraphQL, with no cache of its own. TanStack Query does the caching; two caches, Apollo's and
  Query's, would only get in each other's way.
- The `/* GraphQL */` comment before the template string is only there for IDE syntax
  highlighting.
- The API functions are **plain async functions with no React in them**. They're easy to test and
  easy to mock (`vi.mock('./auth-api')`).

### 3.7 Forms: [login-form.tsx](../../apps/nexus/src/features/auth/login-form.tsx) and [register-form.tsx](../../apps/nexus/src/features/auth/register-form.tsx)

Three libraries work together here:

```tsx
// 1. Zod: the validation schema, which also produces the TS type
const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required.').pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Password is required.'),
});
type LoginValues = z.infer<typeof loginSchema>;   // { email: string; password: string }

// 2. React Hook Form: the form state
const { register, handleSubmit, setError, formState: { errors, isSubmitting } } =
  useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: {...} });

// 3. TanStack Query: the submission itself
const { mutateAsync } = useMutation({ mutationFn: login });
```

| Piece | Why |
| --- | --- |
| **Zod** | The schema is the single source of truth: validation and the `LoginValues` type both come from it. No separate interface to write. |
| **`{...register('email')}`** | Returns `{ name, onChange, onBlur, ref }` and connects the input to the form. Fields are **uncontrolled**: the value lives in the DOM, not in state, so the component doesn't re-render on every keystroke. That's RHF's main advantage over a `useState` per field. |
| **`handleSubmit(fn)`** | Runs Zod first. If there are errors, `fn` isn't called and the errors show up in `errors`. |
| **`isSubmitting`** | `true` while the async `onSubmit` runs. Disables the button and changes its label. |
| **`setError('root.server', …)`** | An error for the whole form, e.g. "Credentials are not valid". |
| **`noValidate`** on `<form>` | Turns off the browser's built-in validation popups so our messages show instead. |
| **`useMutation`** | Mostly groundwork for now. In phase 2, mutations like "send money" will invalidate the balance cache on success, and that logic will live here. |

**Registration** runs `register` and then `login` in one mutation, so the user doesn't have to
type their details twice.

**Why the password check in Zod is so weak** (`min(8)`): the real rules, `@IsStrongPassword()`,
are checked by the server. They aren't duplicated on the client, where they would sooner or later
drift from the server's. The server's answer is handled in `errors.ts`.

### 3.8 Server errors: [errors.ts](../../apps/nexus/src/lib/errors.ts)

NestJS reports validation errors as `"Bad Request Exception"` and hides the real text in
`extensions.originalError.message`, which can be a string or an array.

`applyServerErrors` does two things:

1. Extracts the real messages.
2. If a message starts with a field name (`"password is not strong enough"`), attaches it to that
   field. Everything else becomes the form-level error.

A `TypeError` from `fetch` is handled separately: it means the server can't be reached at all, and
the user sees "Cannot reach the server. Is it running?".

### 3.9 UI building blocks: [button.tsx](../../apps/nexus/src/components/ui/button.tsx), [input.tsx](../../apps/nexus/src/components/ui/input.tsx), [field.tsx](../../apps/nexus/src/components/ui/field.tsx)

```tsx
export function Input({ className, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn('base classes', className)} {...props} />;
}
```

- **Props = the HTML element's attributes + our own.** `...props` passes everything else through
  (`type`, `onChange`, `aria-*`), so the component behaves like a plain `<input>`.
- **`ref` as a regular prop is new in React 19.** It used to need `forwardRef`. RHF needs the
  `ref` to read the value from the DOM, which is why `Input` accepts it.
- **`Button` defaults to `type="button"`.** In HTML a button inside a form is a submit button by
  default, a common source of accidental submits. The form's submit button passes
  `type="submit"` explicitly.
- **`cn()`** joins class names and skips `false`/`undefined`. Whoever uses the component can add
  classes through `className`.
- **Tailwind:** styles are classes right in the markup (`h-10 rounded-md px-4`). No CSS file per
  component. v4 doesn't even have a config file, just `@import 'tailwindcss'` in
  [styles.css](../../apps/nexus/src/styles.css).
- **Accessibility (a11y)** worth remembering:
  - `<label htmlFor>` ties the label to its field; the tests rely on this too.
  - `aria-invalid` turns a field with an error red through `aria-invalid:border-red-500`.
  - `aria-describedby` lets a screen reader read the error text.
  - `role="alert"` announces the form-level error.

---

## 4. One login, end to end

```
1. The user types an email and password: the values live in the DOM, React doesn't re-render
2. Clicks "Sign in" → <form onSubmit> → handleSubmit
3. Zod checks the fields
      ✗ → errors.email is set → <Field> shows the message → stop
      ✓ → our onSubmit runs, isSubmitting = true → the button says "Signing in…"
4. mutateAsync → login() → authClient.request(...)
      → POST localhost:4300/api/auth → (Vite proxy) → localhost:3000/auth
5. auth checks the password, replies { id, email } and sets the HttpOnly cookie
      ✗ error → applyServerErrors → setError → red role="alert" box
6. session.set(user) → localStorage + emit()
      → every component using useSession() re-renders: the email appears in the header
7. onSuccess() → router.history.push(returnUrl or "/")
8. "/"'s beforeLoad sees session.get() ≠ null → lets it through → HomePage
```

---

## 5. Angular → React cheat sheet for this app

| Angular (`apps/ui-admin`) | React (`apps/nexus`) |
| --- | --- |
| Component: class + template + decorator | A function that returns JSX |
| `@Input()` / `input()` | Function parameters (props) |
| `@Output()` / `output()` | A callback prop (`onSuccess`) |
| Service + DI | A module exporting an instance (`session`) or a Context provider |
| `signal()` in a service | External store + `useSyncExternalStore` |
| Change detection | Re-render: the component function runs again when its state, props or subscription change |
| `<router-outlet>` | `<Outlet />` |
| `canActivate` | `beforeLoad` + `throw redirect()` |
| Signal forms / Reactive forms | React Hook Form + Zod |
| Apollo + `rxResource` | graphql-request + TanStack Query (`useQuery`/`useMutation`) |
| `@if` / `@for` in templates | `{cond && <X/>}` and `items.map(...)` in JSX |

**The key mindset shift.** In React a component is a function that **runs again on every
re-render**. So:

- Hooks (`useX`) are always called in the same order, never inside `if`s or loops, and only in
  components or other hooks.
- A component body must not have side effects such as requests or subscriptions. Those belong in
  hooks and event handlers, and that's exactly what `StrictMode` catches.

---

## 6. Tests

Tests sit next to the code as `*.spec.ts(x)`; run them with `npx nx test nexus`. The stack is
Vitest + React Testing Library.

[login-form.spec.tsx](../../apps/nexus/src/features/auth/login-form.spec.tsx) shows RTL's
philosophy: **test the way a user uses the app**, not the component's internals.

```tsx
vi.mock('./auth-api', () => ({ login: vi.fn() }));        // the server is mocked
fireEvent.change(screen.getByLabelText('Email'), {...});  // find the field by its label, like a person would
fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
expect(await screen.findByRole('alert')).toBe(...)        // wait for the error to appear
```

Finding elements by label and role checks accessibility at the same time: if a `<label>` isn't
tied to its field, the test fails.

A trap we fell into: `beforeEach(() => mock.mockReset())` without braces returns the mock, and
Vitest treats a returned function as teardown. That's why the body there is wrapped in `{ }`.

---

## 7. What's not there yet (coming in phase 2)

- **`useQuery`** — loading the balance and history with caching, loading states and retries.
- **Cache invalidation** after a mutation: send money → the balance reloads.
- **Global 401/FORBIDDEN handling** — clear the session and redirect to `/login`, like the error
  link in the Angular app.
- **WebSocket** for live prices and balances (phase 4).

---

## Exercises

1. Add a `/profile` route for signed-in users only. Copy `homeRoute` and watch TypeScript start
   accepting `<Link to="/profile">` right away.
2. Add an icon variant to `Input`, or a `danger` variant to `Button` through the `variants`
   object.
3. Add a "show password" toggle to `LoginForm` with `useState`. That's your first piece of local
   state.
4. Write a test for `RegisterForm` modelled on `login-form.spec.tsx`.
