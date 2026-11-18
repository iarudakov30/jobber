# Production drills

Four experiments that turn interview theory into first-hand experience: break something on
purpose in the services that already exist, measure it, fix it, measure again. They don't belong to
a phase and can be done at any time between phases. Each one ends with numbers and a short story
to tell in an interview: "I reproduced it, measured it, here is what changed".

Suggested order: 1 → 2 → 3 → 4. Drill 1 gives the most visible result and adds the shutdown
hooks that drill 3 builds on; drill 4 logs memory next to the event-loop metric from drill 2.

| #   | Drill                                         | Service       | State   |
| --- | --------------------------------------------- | ------------- | ------- |
| 1   | Zero-downtime rollout (SIGTERM in Kubernetes) | `auth` + Helm | Planned |
| 2   | Event loop blocking                           | `executor`    | Planned |
| 3   | Process crash inside a consumer               | `executor`    | Planned |
| 4   | Memory leak hunt                              | `wallet`      | Planned |

Fault hooks follow the existing `FAULT_ACK_FAILURES` pattern: an env variable, ignored when
`NODE_ENV=production`, so they can stay in the code after the drill.

## 1. Zero-downtime rollout

**Interview question it answers:** "Kubernetes sends SIGTERM during a deploy. What must the
service do so that no request is lost?"

**Starting point (verified in the code):**

- `auth`, `jobs`, `executor` and `products` don't call `app.enableShutdownHooks()` (only `wallet`
  does), so they have no SIGTERM handler.
- `docker-entrypoint.sh` runs `exec node ...`, so node is PID 1. PID 1 without a handler ignores
  SIGTERM: Kubernetes waits the full `terminationGracePeriodSeconds` (30 s) and sends SIGKILL,
  which drops in-flight requests.
- The Helm chart has no readiness or liveness probes and no `preStop`.
- `wallet` isn't in the chart yet (phase 5), so the drill uses `auth`.

**Tasks:**

- [ ] Baseline. Set `auth.replicas: 2`, run `minikube tunnel`, write `apps/auth/load/rollout.js`
      (k6, constant 50 req/s of a cheap GraphQL query against `auth-http` for 90 s).
- [ ] During the k6 run, `kubectl rollout restart deployment/auth -n jobber` and
      `kubectl get pods -n jobber -w`. Record: failed requests, how long the old pod stays
      `Terminating`. Expected: errors, and ~30 s per pod.
- [ ] Add `enableShutdownHooks()` to `init()` in `libs/nestjs`, so every app handles SIGTERM.
- [ ] Health endpoints: `/health/live` (always 200 while the process runs) and `/health/ready`
      (503 once shutdown starts; optionally checks the DB).
- [ ] In `beforeApplicationShutdown`, flip readiness to 503 and wait `SHUTDOWN_DELAY_MS`
      (default 10 s) before Nest closes the HTTP server. Alternative: `preStop` in the manifest
      (`sleep: { seconds: 10 }` on Kubernetes 1.30+, otherwise `exec: sleep 10`).
- [ ] Helm: `readinessProbe`, `livenessProbe`, `terminationGracePeriodSeconds` larger than the
      delay plus the longest request. `helm lint charts/jobber` passes.
- [ ] Re-run the baseline three times.

**Done when:** three rollouts in a row under load give 0 failed requests, the old pod disappears
in well under 30 s, and the before/after numbers are written down below.

**Results:** _(fill in: failed requests before → after, termination time before → after)_

## 2. Event loop blocking

**Interview question it answers:** "What happens if a handler does 2 seconds of synchronous CPU
work? When do you need `worker_threads`?"

**Starting point:** all Pulsar consumers in `executor` share one event loop. `FibonacciMessage`
caps `iterations` at `MAX_FIBONACCI_ITERATIONS` (1,000) for exactly this reason, and
`FibonacciConsumer.execute` calls `iterate()` from the `fibonacci` package synchronously.

**Tasks:**

- [ ] Add an event-loop delay metric: `perf_hooks.monitorEventLoopDelay()`, logging p50, p99 and
      max every 10 s. Put it in `libs/nestjs` so any app can turn it on.
- [ ] Locally (don't commit), raise the cap until one Fibonacci message takes a few seconds.
- [ ] Run a large Fibonacci job and a `LoadProducts` job at the same time. Record: event-loop
      delay max and p99, how long `LoadProducts` takes compared with running it alone, any
      Pulsar redeliveries or gRPC deadline errors.
- [ ] Move the calculation into a worker pool (`piscina`): `execute` awaits `pool.run(...)`.
      Size the pool from `os.availableParallelism()`.
- [ ] Repeat the measurement.
- [ ] Decide whether the cap stays. (It should: a worker pool protects the event loop, not the
      CPU or memory.)

**Done when:** before/after numbers for event-loop delay and `LoadProducts` duration are written
down, Fibonacci runs in a worker pool, and `executor` tests pass.

**Results:** _(fill in)_

## 3. Process crash inside a consumer

**Interview questions it answers:** "What do you do in `uncaughtException`? What happens to the
message the process was working on when it crashed?"

**Tasks:**

- [ ] Fault hook `FAULT_THROW=<n>`: the first n messages throw inside `execute`. Expected: the
      consumer nacks, Pulsar redelivers, after 5 redeliveries the message goes to the DLQ, and the
      process stays up. Verify it.
- [ ] Fault hook `FAULT_CRASH=<n>`: the first n messages trigger a rejection outside the awaited
      chain (`void Promise.reject(...)`, or a `throw` inside `setTimeout`). Expected: the process
      exits (Node 15+ turns an unhandled rejection into a crash). Verify it.
- [ ] After the crash, restart `executor` and check: the in-flight message is redelivered, the
      job ends `COMPLETED`, and `completed` equals `size` (idempotent acks from phase 1).
- [ ] Add process-level handlers in `libs/nestjs`: on `uncaughtException` and
      `unhandledRejection`, log a fatal line synchronously (pino), call `app.close()` with a
      timeout, exit with code 1. Never log and carry on.
- [ ] Optional, in minikube: watch the pod's `RESTARTS` counter grow and the job still complete.

**Done when:** both fault hooks behave as described, the crash leaves a fatal log line with the
stack, and the job is still counted correctly after the restart.

**Results:** _(fill in)_

## 4. Memory leak hunt

**Interview question it answers:** "Memory grows from 200 MB to 1.5 GB over a day, then the
service dies with `heap out of memory`. How do you find the cause?"

**Tasks:**

- [ ] Fault hook `FAULT_LEAK=1` in `wallet`: an interceptor stores something per request in a
      module-level `Map` keyed by a request id and never deletes it. Make the stored value large
      enough to show up (for example, the whole GraphQL context).
- [ ] Log `process.memoryUsage()` (`rss`, `heapUsed`, `external`) every 10 s, next to the
      event-loop metric from drill 2.
- [ ] Write `apps/wallet/load/leak.js` (k6: `balances` in a loop for 60 s).
- [ ] Three snapshots: warm up → snapshot 1 → load → snapshot 2 → load → snapshot 3. Run
      `wallet` with `--inspect` and use Chrome DevTools → Memory.
- [ ] In DevTools: snapshot 3, **Comparison** with snapshot 1, sort by **# Delta**. Find the
      object that grows with each wave, and follow **Retainers** to the `Map`.
- [ ] Take a snapshot without DevTools as well: `v8.writeHeapSnapshot()` from a dev-only endpoint,
      or `--heapsnapshot-near-heap-limit=2 --max-old-space-size=256` to catch the moment before
      OOM. (`--heapsnapshot-signal=SIGUSR2` doesn't work on Windows.)
- [ ] Fix it (bounded `lru-cache` with a TTL, or no cache at all) and repeat: `heapUsed` stays
      flat across three waves of load.

**Done when:** the retainer chain to the leaking `Map` is identified from the snapshots, a
snapshot was also taken without DevTools, and after the fix the heap is flat. Notes and
screenshots are kept below.

**Results:** _(fill in: heapUsed per wave before → after, the retainer chain)_
