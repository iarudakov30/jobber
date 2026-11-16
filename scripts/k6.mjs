// Runs one of the wallet's k6 load tests (apps/wallet/load/<name>.js) in Docker:
//
//   npx nx run wallet:load-test overdraft      # or: deadlock, same-key
//
// auth (3000) and wallet (3004, gRPC 5003) must be running; the container reaches them at
// host.docker.internal. Extra arguments go to `k6 run`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const K6_IMAGE = 'grafana/k6:1.4.2';
const root = fileURLToPath(new URL('..', import.meta.url));
const [name, ...k6Args] = process.argv.slice(2);
const script = `${root}apps/wallet/load/${name}.js`;
if (!name || !existsSync(script)) {
  console.error(
    'Usage: node scripts/k6.mjs <overdraft|deadlock|same-key> [k6 args]',
  );
  process.exit(2);
}

const { status } = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-i',
    '--add-host=host.docker.internal:host-gateway',
    '-v',
    `${root}apps/wallet/load:/load:ro`,
    '-v',
    `${root}libs/grpc/src/lib/proto:/protos:ro`,
    K6_IMAGE,
    'run',
    ...k6Args,
    `/load/${name}.js`,
  ],
  // MSYS_NO_PATHCONV: under Git Bash, docker would otherwise get rewritten container paths.
  { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
);
process.exit(status ?? 1);
