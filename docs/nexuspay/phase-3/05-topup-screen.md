# Step 5 — Top-up screen

- **Where:** committed directly to `main`.

## Why

After step 4 a top-up worked end to end, but only by calling `createTopUp` by hand and signing
the webhook ourselves. This step lets a user top up from the React app, pays on Stripe's real
Checkout page with a test card, and lets the real Stripe send the webhook through the Stripe CLI.
It is also the first time the user waits for something asynchronous: the money arrives a moment
after Stripe says "paid", and the page has to show that honestly.

## What changed

| Area                    | Change                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/nexus`            | `/topup` (`features/topup/topup-page.tsx`): amount with presets, one `Idempotency-Key` per amount, `createTopUp`, then `window.location.assign(checkoutUrl)`                                          |
| `apps/nexus`            | `/wallet?topup=<paymentId>` (`TopUpStatus`): polls `payment(id)`, then the wallet's `topUp(paymentId)`, once a second for up to 30 s each; refreshes balances only after the credit; can be dismissed |
| `apps/nexus`            | Vite proxy `/api/payments` → 3005, `paymentsClient`, codegen output `src/gql/payments` from `apps/payments/schema.gql`; "Top up" in the header and on the Wallet page                                |
| `apps/wallet`           | **New:** GraphQL `topUp(paymentId: ID!): LedgerEntry` — the user's entry for that top-up, `null` until it is credited                                                                                |
| Docs                    | This log; architecture ("what runs today" is the whole phase 3), repo guide (the Stripe CLI run), roadmap, CLAUDE.md                                                                                |

## How it works

### Starting a top-up

```
/topup: "50" → Zod (parseAmount, $1.00..$1,000.00) → "5000"
  → createTopUp({ amount: "5000" }), Idempotency-Key = one UUID per amount
  → { paymentId, checkoutUrl } → window.location.assign(checkoutUrl)
Stripe Checkout → paid   → success_url /wallet?topup=<paymentId>
                → "Back" → cancel_url  /topup
```

The key is kept while the amount stays the same, as on `/send`. If the request times out or
Stripe is briefly down (`PAYMENT_PROVIDER_UNAVAILABLE`), pressing the button again gets the first
top-up back instead of starting a second one. After `createTopUp` succeeds the button stays
disabled ("Opening Stripe…"): the page is about to unload, and a second click would start
another payment. The server's refusals that name the amount ("amount is over your limit of
$2,000.00 per 24 hours: …") land on the amount field.

### Coming back: two waits, not one

The spec said: poll `payment(id)`, and on `SUCCEEDED` refresh the balances. Doing only that shows
a wrong page. `SUCCEEDED` is written by `payments` when the webhook arrives, and the credit
happens in another service after a trip through Pulsar. In the live run below that gap was
about 330 ms (SUCCEEDED at 20:16:14.523, credited at 14.855), longer than a balance query takes. With Pulsar down it can be minutes.
So "Payment succeeded" next to the old balance is a real possibility.

So the page waits twice:

```
payment(id)                      (payments)   PENDING … → SUCCEEDED | EXPIRED | FAILED
  SUCCEEDED → topUp(paymentId)   (wallet)     null … → { amount, asset }
                → invalidate ['wallet'] → balances and history reload
```

`topUp(paymentId)` is a small new wallet query. It returns the signed-in user's ledger entry
whose transaction is `type 'topup'`, `external_ref = paymentId`, or `null`. It's scoped to the
user (someone else's payment id returns `null`), and a malformed id is `BAD_USER_INPUT`.

| What the page shows                                                     | When                                       |
| ----------------------------------------------------------------------- | ------------------------------------------ |
| "Waiting for Stripe to confirm $50.00…"                                 | payment `PENDING`                          |
| "Payment received. Adding $50.00 to your wallet…"                       | `SUCCEEDED`, wallet hasn't credited yet    |
| "$50.00 added to your wallet."                                          | credited; balances reload now              |
| "…expired before it was paid" / "…could not be started. Nothing was charged." | `EXPIRED` / `FAILED` (an alert)      |
| "Stripe hasn't confirmed…" / "…will show in your wallet shortly."       | 30 polls without an answer; polling stops  |

Each poll is a TanStack Query `refetchInterval` that returns `false` once the answer is final or
after 30 answers. The count is `dataUpdateCount` in the query cache. The query result doesn't
expose it, so the component reads it with `queryClient.getQueryState`. The credit query has its
own key (`['payments', 'credit', id]`), outside `['wallet']`, so the invalidation that reloads the
wallet doesn't refetch it. Phase 4's realtime feed replaces all of this polling.

### The Stripe CLI

```bash
stripe listen --print-secret             # the whsec_ secret for apps/payments/.env.local
stripe listen --events "checkout.session.completed,checkout.session.expired" \
  --forward-to localhost:3005/payments/webhooks/stripe
stripe events resend <evt_id>            # acceptance test 3
```

With `stripe login` done once, the signing secret stays the same across `stripe listen` sessions
of that login. So `--print-secret` can fill `.env.local` before `payments` starts.

## How it was verified

- **`npx nx test nexus`:** 53 tests, 17 new (MSW):
  - `/topup`: four invalid amounts are refused without a request; "50" is sent as `"5000"` with
    a key and opens the Checkout URL; a preset fills the amount; the limit refusal lands on the
    field; a Stripe outage is shown and the retry reuses the key; a changed amount gets a new
    key;
  - `TopUpStatus`: `PENDING → SUCCEEDED → credit`, with the wallet invalidated only after the
    credit; `EXPIRED` and `FAILED` stop polling after one answer; it gives up after `maxPolls`
    in both waits; an unknown payment; Dismiss;
  - `WalletPage` with `topUpId`: the message and the new balance appear.
- **`npx nx test wallet`:** 60 tests, 1 new: `topUp` is `null` before the credit, the entry after,
  `null` for another user, and `BAD_USER_INPUT` for a malformed id. The schema check covers the
  new query in `schema.gql`.
- **Live, by hand (spec acceptance tests 2 and 3).** `auth`, `wallet`, `payments`, `executor` and
  `nexus` ran, with `stripe listen` forwarding to `payments`:
  - **Test 2:** signed in as alice ($72.50), Top up → $50 → Stripe Checkout → card 4242 4242 4242
    4242. The `checkout.session.completed` webhook came at 20:16:14 and got 200. The wallet
    credited about 330 ms later, and the executor's email went out within a second. Balance
    $122.50, one email in Mailpit ("Your top-up of $50.00 is in your NexusPay wallet"). Jaeger
    showed one trace of 35 spans:

    ```
         0 ms payments  POST (webhook)
        22 ms payments  payment-succeeded publish
       246 ms wallet    payment-succeeded process
       349 ms wallet    notifications publish
       375 ms executor  notifications.email process
       411 ms auth      grpc.auth.AuthService/GetUser
    ```

  - **Test 3:** `stripe events resend evt_…` ten times. All 11 deliveries got 200. Still one
    `stripe_events` row, one `topup` transaction, one `email.topup` outbox record, one email
    and a $122.50 balance.
- **Test 11:** `npx nx affected -t lint test build`: green (nexus, wallet, nexus-e2e).

## Lessons

- **"Paid" and "credited" are two facts in two services.** A status page that only listens to
  the first can show success next to an unchanged balance. When a flow crosses a broker, the UI
  has to wait for the service that owns the number it shows.
- **The Stripe CLI changed under the spec.** Version 1.55 refuses `stripe listen` without
  `--events` (or `--all-snapshot` / `--all-thin`). In PowerShell the comma-separated list must be
  quoted. Unquoted, PowerShell passes an array, the CLI gets the names joined by a space, and it
  warns that this "isn't a valid event".
- **The page that redirects must stay disabled.** Between `createTopUp` and the browser leaving,
  a click on a re-enabled button starts a second payment. The key protects only a retry with the
  same key, and a new click on a fresh form wouldn't have it.
- **jsdom can't leave the page.** `window.location.assign` isn't implemented, so `TopUpPage`
  takes a `goTo` prop that tests replace with a spy.
