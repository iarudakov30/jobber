# End-to-End Testing on Minikube

## Overview

This walks through exercising the full request chain on the local `jobber` Helm release — `auth` → `jobs` → Pulsar → `executor` → `products` — using nothing but `kubectl` and `curl`. It's useful both as a smoke test after redeploying and as a map of how the services actually talk to each other.

Prerequisites: the `jobber` release is installed and every pod in the `jobber`, `postgresql`, and `pulsar` namespaces is `Running`/`Completed` (`kubectl get pods -n jobber`, etc.).

---

## How this all fits together

Before testing anything, it helps to know what's actually being deployed and by what.

### The Dockerfiles — one per app

Each of the four services (`auth`, `jobs`, `executor`, `products`) has its own `Dockerfile` at `apps/<name>/Dockerfile`. They all follow the same multi-stage shape:

- **`builder` stage** (`node:20-slim`): copies in just enough of the monorepo to build one app — the root `package.json`/`package-lock.json`/`nx.json`/webpack configs, the app's own `apps/<name>` folder, and whichever `libs/*` it actually depends on (e.g. `auth` needs `libs/graphql`, `libs/grpc`, `libs/nestjs`, `libs/prisma`; `jobs` additionally needs `libs/pulsar`). Runs `npm install`, generates the Prisma client for apps that have one (`auth`, `jobs`), then `npx nx build <app>` to produce `dist/apps/<app>`.
- **`runner` stage** (`node:20-slim`): a fresh, minimal image. Copies over only the built `dist` output, the per-app/per-lib `package.json` files (plus the root lockfile) and runs `npm ci` for production dependencies, copies the generated Prisma client if there is one, and sets an `ENTRYPOINT` on `docker-entrypoint.sh`.

The point of the split is that the final image doesn't carry the whole monorepo's dev toolchain (TypeScript, webpack, nx, the other three apps' source) — just what that one service needs to run.

**Important:** these images are built locally, tagged `auth:latest` / `jobs:latest` / `executor:latest` / `products:latest`, and never pushed anywhere. The chart's `values.yaml` sets `global.imagePullPolicy: Never`, which tells Kubernetes "don't try to pull this, it must already be sitting in the node's own container runtime." That's only true if you built the image _inside minikube's Docker daemon_ (see step 0 below) — building it with your normal local `docker build` puts it in the wrong place and the pod will sit in `ErrImageNeverPull`.

### CI (`.github/workflows/ci.yml`)

CI is intentionally narrow: checkout → `npm ci` → `npx nx affected -t lint test build`. It lints, tests, and build-compiles whatever Nx detects as affected by the change — it does **not** build Docker images, push anywhere, or touch the cluster. There's no AWS/ECR step (that was removed) and no deploy step at all; running this stack anywhere (locally or otherwise) is a manual, separate action from CI. Think of CI as "does the code still compile and pass tests," not "is this deployed."

### The Helm chart (`charts/jobber`)

- **`Chart.yaml`** declares the chart as `jobber` and lists two external dependencies pulled from their upstream chart repos: `postgresql` (Bitnami, v16.2.1) and `pulsar` (Apache, v3.7.0). These aren't our code — they're off-the-shelf charts for the two pieces of infrastructure the apps need.
- **`Chart.lock`** pins the exact resolved versions of those dependencies. **`charts/jobber/charts/*.tgz`** are the actual vendored copies of those subcharts (fetched by `helm dependency build` — see step 0). They aren't committed to git, so a fresh clone won't have them yet.
- **`values.yaml`** is the one file you'll touch most. It has a block per app (`auth:`, `jobs:`, `executor:`, `products:` — image tag, ports, replica count, JWT config for `auth`), plus a `postgresql:` block (credentials, and an `initdb` script that runs `CREATE DATABASE auth/products/jobs` the first time the Postgres pod starts) and a `pulsar:` block (which components to run, replica counts, image repository/tag). `ingress.alb: false` and `persistence.ebs: false` switch off the AWS-specific bits (ALB annotations, EBS-backed storage class) so the chart behaves as a plain local chart.
- **`templates/`** holds our own manifests, one folder per app (`auth/`, `jobs/`, `executor/`, `products/`), each with a `Deployment` and one or more `Service`s (HTTP + gRPC where relevant). `jobs/pvc.yaml` claims a small volume for uploaded files. `_helpers.tpl`/`common.tpl` hold shared template snippets (e.g. common env vars injected into every container). `ingress.yaml` and `storage-class.yaml` are the AWS-oriented bits — only render anything when `ingress.alb`/`persistence.ebs` are `true`, so on minikube they're effectively no-ops.

So: our four `Deployment`s reference locally-built, never-pulled images; the `postgresql` and `pulsar` subcharts pull their images from Bitnami/Apache's public registries like any normal chart would, and their `values.yaml` blocks just configure them to run in a single-replica, no-persistence-fuss way suited to a laptop.

### What actually needs to happen before `helm install` will work

Installing the chart alone is **not enough** — it will schedule pods that immediately fail to find their images. In order:

```bash
minikube start                        # 0a. have a cluster to deploy into

eval $(minikube docker-env)           # 0b. point your shell's `docker` CLI at
                                       #     minikube's *internal* Docker daemon —
                                       #     everything below in this shell now
                                       #     builds into the cluster, not your host

docker build -t auth:latest      -f apps/auth/Dockerfile      .
docker build -t jobs:latest      -f apps/jobs/Dockerfile      .
docker build -t executor:latest  -f apps/executor/Dockerfile  .
docker build -t products:latest  -f apps/products/Dockerfile  .
                                       # 0c. build all four images — this is the step
                                       #     that satisfies imagePullPolicy: Never

helm dependency build charts/jobber   # 0d. fetch the postgresql + pulsar subcharts
                                       #     into charts/jobber/charts/*.tgz (only
                                       #     needed once, or after Chart.yaml changes)

helm upgrade --install jobber charts/jobber -n jobber --create-namespace
                                       # 0e. actually deploy
```

So the answer to "is it just `docker build`" is: no — it's `minikube start` + building the four images _inside minikube's own Docker daemon_ (easy to forget the `eval $(minikube docker-env)` step and build into the wrong daemon) + resolving the Helm chart's external dependencies + the `helm upgrade --install` itself. Skipping the `docker-env` step is the most common way this goes wrong — the build succeeds, but minikube's node has never heard of the image.

If you change app source and need to redeploy just that one service, you only need to redo its `docker build` (again inside `minikube docker-env`) and then bounce its pod so it picks up the new image (`kubectl delete pod -n jobber -l app=<name>` — a plain `imagePullPolicy: Never` pod won't notice a retagged image on its own).

---

## 1. Port-forward the GraphQL services

Pick local ports that are free on your machine. `3000`/`3001` are likely already taken by `npm start`'s local `nx serve` processes — use something else (e.g. `13000`/`13001`) so you don't silently hit your local dev servers instead of the cluster.

```bash
kubectl port-forward -n jobber svc/auth-http 13000:3000 &
kubectl port-forward -n jobber svc/jobs-http 13001:3001 &
```

Sanity check that `kubectl`, not some other process, actually owns the port:

```bash
ss -ltnp | grep -E ":13000|:13001"
```

---

## 2. Sign up a test user (`auth`)

```bash
curl -s -X POST http://localhost:13000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { createUser(createUserInput: { email: \"k8s-e2e@example.com\", password: \"Str0ng!Passw0rd\" }) { email } }"}'
```

Expected: `{"data":{"createUser":{"email":"k8s-e2e@example.com"}}}`

## 3. Log in and capture the JWT cookie

```bash
curl -s -X POST http://localhost:13000/graphql \
  -H "Content-Type: application/json" \
  -c .cookies.txt \
  -d '{"query":"mutation { login(loginInput: { email: \"k8s-e2e@example.com\", password: \"Str0ng!Passw0rd\" }) { email } }"}'
```

This sets an `Authentication` cookie (JWT) in `.cookies.txt`, which `jobs` will validate on every subsequent request by calling `auth` over gRPC.

## 4. Trigger the `Fibonacci` job

Exercises: `jobs` GraphQL → gRPC call to `auth` (token check) → Prisma write (`Job` row) → Pulsar publish.

```bash
curl -s -X POST http://localhost:13001/graphql \
  -H "Content-Type: application/json" \
  -b .cookies.txt \
  -d '{"query":"mutation { executeJob(executeJobInput: { name: \"Fibonacci\", data: { iterations: 15 } }) { name description } }"}'
```

Expected: `{"data":{"executeJob":{"name":"Fibonacci","description":"Generate a Fibonacci sequence and store it in the DB."}}}`

## 5. Trigger the `LoadProducts` job

Exercises everything above, plus: Pulsar delivery to `executor` → gRPC call from `executor` to `products` → Drizzle write.

```bash
curl -s -X POST http://localhost:13001/graphql \
  -H "Content-Type: application/json" \
  -b .cookies.txt \
  -d '{"query":"mutation { executeJob(executeJobInput: { name: \"LoadProducts\", data: { name: \"K8s E2E Widget\", category: \"Gadgets\", price: 9.99, stock: 5, rating: 3.5, description: \"test\" } }) { name description } }"}'
```

---

## 6. Verify `executor` actually consumed both messages

```bash
kubectl logs -n jobber -l app=executor --tail=10
```

You should see one `FibonacciConsumer: {...}` line (with the computed Fibonacci number) and one `LoadProductsConsumer: {...}` line (echoing the product payload plus a `jobId`).

## 7. Verify the writes actually landed in Postgres

A 200 response only proves the API accepted the request — check the database directly to confirm the full chain really persisted data, not just that a request/response round-tripped:

```bash
kubectl exec -n postgresql jobber-postgresql-0 -- env PGPASSWORD=postgres psql -U postgres -d auth -c "SELECT id, email FROM \"User\";"
kubectl exec -n postgresql jobber-postgresql-0 -- env PGPASSWORD=postgres psql -U postgres -d jobs -c "SELECT id, name, status FROM \"Job\";"
kubectl exec -n postgresql jobber-postgresql-0 -- env PGPASSWORD=postgres psql -U postgres -d products -c "SELECT name, category, price FROM products;"
```

---

## 8. Cleanup

```bash
pkill -f "kubectl port-forward -n jobber svc/auth-http"
pkill -f "kubectl port-forward -n jobber svc/jobs-http"
rm -f .cookies.txt
```

---

## Gotcha: port collisions with local dev servers

`kubectl port-forward` fails to bind silently if the local port is already taken — it writes an error to its own stdout/stderr rather than raising anything you'd notice from a background job. If you forward to `3000`/`3001` while `npm start` (or `nx serve auth`/`nx serve jobs`) is already running locally, your `curl` calls will quietly hit the local dev server instead of the cluster, and you'll get plausible-looking successful responses that have nothing to do with the deployment you're trying to test.

If a test "passes" but you're not sure which backend actually served it, cross-check with `ss -ltnp` (see step 1) or, more reliably, go straight to step 7 and confirm the data via `kubectl exec ... psql`.
