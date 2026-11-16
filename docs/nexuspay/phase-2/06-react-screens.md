# Step 6 — Wallet and Send screens

- **Where:** committed directly to `main`.

## Why

Steps 1–5 built and proved the ledger behind GraphQL. This step shows it to a person: the React
app gets a Wallet page (balances and history) and a Send page. The spec's last acceptance tests
run in a real browser: log in, see the seeded money, send $5, check both sides, and make sure a
double click on Send creates one transfer.

## What changed

| Area                  | Change                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/nexus` pages    | `/wallet` (balances + history with "Load more", `useInfiniteQuery`), `/send` (React Hook Form + Zod, one `Idempotency-Key` per transfer); `/` redirects to `/wallet`; Wallet/Send links in the header; the placeholder home page is gone             |
| `apps/nexus` plumbing | Vite proxy `/api/wallet` → 3004; `walletClient`; `createQueryClient()` (a `FORBIDDEN` answer clears the session and goes to `/login?returnUrl=…`); `Card` and `FormSuccess` components; TypeScript target ES2022 (bigint literals from `libs/money`) |
| GraphQL Codegen       | `apps/nexus/codegen.ts`, target `nexus:codegen`: client preset, one output per backend (`src/gql/auth`, `src/gql/wallet`) from the committed schema files; `auth-api.ts` now uses the typed documents too                                            |
| `apps/auth`           | Prints `apps/auth/schema.gql` on startup (`autoSchemaFile`, `sortSchema`); `schema.spec.ts` fails when the committed file is stale                                                                                                                   |
| Tests                 | MSW 3 (`msw/graphql`) for the pages: 3 Wallet, 13 Send, 3 query-client tests; new Playwright project `apps/nexus-e2e` (5 tests, against the real services)                                                                                           |
| CI                    | After lint/test/build: run `nexus:codegen` and fail if `apps/nexus/src/gql` changed (spec acceptance test 10)                                                                                                                                        |
| Tooling               | Root dev dependencies `@graphql-codegen/cli` 7, `@graphql-codegen/client-preset` 6, `msw` 3, `@playwright/test` 1.65; `scripts/stop.mjs` now also stops servers listening only on IPv6 (`[::1]:4300`)                                                |

**Not done as specified:** `shadcn/ui init`. Phase 1 already wrote its components (`Button`,
`Input`, `Field`) by hand in shadcn's style. The CLI would restyle the existing auth pages and add
several dependencies for the two new pieces this step needed (`Card`, `FormSuccess`), which are
hand-written the same way. It can still be adopted later, one component at a time.

## How it works

### Money in the browser

The API sends `MinorUnits` strings (`"9500"`). The UI parses what a person types with
`parseAmount` from `@jobber/money` (Vite resolves the workspace path), which refuses `"1.234"`
instead of rounding. It formats with `formatAmount`, so `$95.00` never goes through a float.
Codegen maps `MinorUnits` and `DateTime` to `string`.

### The Send form and its Idempotency-Key

```
submit → Zod (email, amount > $0.00 with at most 2 decimals) → parseAmount → toWire
       → key: the same as the last attempt if recipient and amount are unchanged,
              otherwise a new crypto.randomUUID()
       → transfer(input) with header Idempotency-Key
            success  → "Sent $5.00 to …", form cleared, key dropped, wallet queries refreshed
            CONFLICT → "still being processed" (the first click's request is running)
            known refusal → on its field ("No NexusPay user has this email.", …)
            anything else (network error, timeout) → message; the key is kept for the retry
```

There are two layers against double submission. An in-flight ref ignores a second submit while
the first is running; a fast double click submits twice before React re-renders the button as
disabled. Behind that, the key: if the first request did reach the server and only the answer was
lost, a retry with the same values sends the same key and gets the stored result instead of a
second transfer.

### Sessions

The JWT cookie is HttpOnly, so the app only learns that a session ended when a backend answers
`FORBIDDEN`. `createQueryClient` handles it for every query and mutation: it clears the stored
user and navigates to `/login?returnUrl=<current page>`. It doesn't retry such queries.

### Codegen without a server

Both backends print their schema at startup (`apps/auth/schema.gql`, `apps/wallet/schema.gql`) and
the files are committed. Each backend has a test that fails when its file is stale. `codegen.ts`
reads those files, so `npx nx run nexus:codegen` works offline, and CI regenerates and fails on
any difference. The generated code is excluded from Prettier and ESLint, so the bytes CI compares
are exactly what codegen writes.

## How it was verified

- **`npx nx test nexus`** (36 tests: 19 new). MSW answers GraphQL at the network level, so the
  tests also check the requests themselves.
  - **Wallet page:**
    - shows `$95.00` and the first history page; "Load more" asks for `after: "3"` and appends
      `+$100.00`; the button disappears on the last page
    - shows "No transactions yet." for a new user
    - shows a failed load as an alert
  - **Send page, validation and requests:**
    - four invalid inputs are refused before any request
    - `"5"` is sent as `"500"` with a UUID `Idempotency-Key`, the form is cleared, and the success
      line reads "Sent $5.00 to bob@example.com."
  - **Send page, keys and errors:**
    - after a network error, the retry reuses the key; the next transfer gets a new one
    - changed input gets a new key
    - two submits at once make one request. Removing the in-flight guard makes this test fail; I
      checked.
    - the three refusals land on their fields, linked through `aria-describedby`
    - `CONFLICT` explains itself
  - **Query client:** `FORBIDDEN` clears the session and signs out; other errors don't; a
    `FORBIDDEN` query isn't retried.
- **`npx nx test auth`:** `schema.spec.ts` passes on the committed file and fails after a stray
  field is added to it.
- **`npx nx run nexus-e2e:e2e`** (spec acceptance test 9): 5 Playwright tests in Chromium against
  the built `auth` and `wallet` plus the `nexus` dev server. Global setup creates two fresh users
  and credits the sender $100.00 over gRPC.
  1. Sign in → `/wallet` shows `$100.00` and `+$100.00` in the history.
  2. Send $5 → "Sent $5.00 to …"; after a reload the sender shows `$95.00` with one `-$5.00`; the
     recipient, in a separate browser context, shows `$5.00`.
  3. Double-click Send with $1 → the sender is at `$94.00` with exactly one `-$1.00`; the recipient
     is at `$6.00`.
  4. Sending $1,000 → "Not enough money in your wallet."; the balance is still `$94.00`.
  5. A visitor without a session who opens `/send` lands on `/login?returnUrl=…`.

  All five passed, again after the last change to the Send page.

- **Screenshots** of `/wallet` and `/send` (an unknown recipient) as alice looked right: header
  links, the balance card, the history with signed amounts, the field error under the email.
- **Spec acceptance test 10:** codegen run twice gives byte-identical output; CI reruns it and
  fails on changes.
- **`npx nx run-many -t lint test build`:** all 17 projects green. `dist/apps/nexus` holds the
  built `index-*.js` and `.css` (acceptance test 11).

## Lessons

- **MSW 3 moved `graphql`** to its own entry point: `import { graphql } from 'msw/graphql'`. The
  `msw` import of v2 is `undefined` there.
- **A TanStack Router page renders after the router loads**, so a test that looks for the form
  right after `render()` finds nothing. `renderPage()` awaits `router.load()` first.
- **The React Compiler lint (`react-hooks/refs`) flags refs used in a callback passed to a call
  during render**, such as `handleSubmit(fn)`, since it can't know the callback runs later.
  Calling `handleSubmit(fn)(event)` inside the submit handler keeps the refs out of render.
- **`netstat -ano -p tcp` on Windows lists IPv4 sockets only.** Vite's dev server listens on
  `[::1]` alone, so `npm stop` never stopped nexus. It now reads all TCP sockets.
- **Playwright's `globalSetup` can hand data to the tests through `process.env`.** The run's
  fresh users travel as `NEXUS_E2E_USERS`, so each run starts from known balances whatever
  earlier runs left behind.
