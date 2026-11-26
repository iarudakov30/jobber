import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The realtime gateway the e2e run starts itself, so the reconnect test (spec acceptance test
 * 10) can kill it the way a replica dies and start another. Built bundle:
 * `dist/apps/realtime/main.js` (the e2e target depends on `realtime:build`).
 */
const ROOT = join(__dirname, '../../..');
const BUNDLE = join(ROOT, 'dist/apps/realtime/main.js');
const STATS_URL = 'http://localhost:3007/realtime/stats';
/** Where the pid of the gateway this run started is kept, for the test and the teardown. */
const STATE = join(tmpdir(), 'nexus-e2e-gateway.json');

export async function gatewayRunning(): Promise<boolean> {
  try {
    return (await fetch(STATS_URL)).ok;
  } catch {
    return false;
  }
}

/** Starts a gateway on 3007 and resolves once it answers; remembers its pid. */
export async function startGateway(): Promise<number> {
  if (!existsSync(BUNDLE)) {
    throw new Error(`${BUNDLE} is missing: run npx nx build realtime`);
  }
  const child = spawn(
    process.execPath,
    ['--env-file=apps/realtime/.env', BUNDLE],
    {
      cwd: ROOT,
      env: { ...process.env, OTEL_SDK_DISABLED: 'true' },
      stdio: 'ignore',
      detached: true,
    },
  );
  child.unref();
  const pid = child.pid;
  if (!pid) {
    throw new Error('the gateway did not start');
  }
  writeFileSync(STATE, JSON.stringify({ pid }));
  const deadline = Date.now() + 30_000;
  while (!(await gatewayRunning())) {
    if (Date.now() > deadline) {
      throw new Error('the gateway did not answer within 30 s');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return pid;
}

/** The pid of the gateway this run started, if it started one. */
export function ownedGateway(): number | undefined {
  if (!existsSync(STATE)) {
    return undefined;
  }
  return JSON.parse(readFileSync(STATE, 'utf8')).pid;
}

/** Kills the gateway at once, without its shutdown (no 1012): a replica dying. */
export function killGateway(): void {
  const pid = ownedGateway();
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(STATE, { force: true });
}

export const GATEWAY_STATE_FILE = STATE;
