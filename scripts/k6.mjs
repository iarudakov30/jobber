// Runs one of a project's k6 load tests (<project>/load/<name>.js) in Docker, from the project's
// directory (the Nx `load-test` target sets it):
//
//   npx nx run wallet:load-test overdraft      # or: deadlock, same-key
//   npx nx run realtime:load-test prices-and-fills
//
// The services the script talks to must be running; the container reaches them at
// host.docker.internal. Extra arguments go to `k6 run` (e.g. -e DURATION=1m).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const K6_IMAGE = 'grafana/k6:1.4.2';
const root = fileURLToPath(new URL('..', import.meta.url));
const loadDir = join(process.cwd(), 'load');
const [name, ...k6Args] = process.argv.slice(2);
if (!name || !existsSync(join(loadDir, `${name}.js`))) {
  const scripts = existsSync(loadDir)
    ? readdirSync(loadDir)
        .filter((f) => f.endsWith('.js') && f !== 'lib.js')
        .map((f) => f.slice(0, -3))
    : [];
  console.error(
    `Usage: node scripts/k6.mjs <${scripts.join('|')}> [k6 args] (from a project directory)`,
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
    `${loadDir}:/load:ro`,
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
