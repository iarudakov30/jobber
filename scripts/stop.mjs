// Kills the Node processes listening on the dev ports. Works on Windows (netstat) and
// Linux/macOS (lsof). Other programs on these ports (e.g. a .NET app on 5000) are left alone.
import { execSync } from 'node:child_process';

const PORTS = {
  3000: 'auth',
  3001: 'jobs',
  3002: 'executor',
  3003: 'products',
  5000: 'auth gRPC',
  5001: 'products gRPC',
  5002: 'jobs gRPC',
  4200: 'ui-admin',
  4300: 'nexus',
};

function listeningPids(port) {
  try {
    if (process.platform === 'win32') {
      return execSync('netstat -ano -p tcp', { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(
          ([, local, , state]) =>
            state === 'LISTENING' && local?.endsWith(`:${port}`),
        )
        .map((cols) => Number(cols[4]));
    }
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

function processName(pid) {
  try {
    const command =
      process.platform === 'win32'
        ? `tasklist /FI "PID eq ${pid}" /FO CSV /NH`
        : `ps -p ${pid} -o comm=`;
    return execSync(command, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const isNode = (name) =>
  /(^|[\\/"])node(\.exe)?("|$)/i.test(name.split(',')[0]);

const killed = new Set();
for (const [port, app] of Object.entries(PORTS)) {
  for (const pid of listeningPids(port)) {
    if (!pid || killed.has(pid)) continue;
    const name = processName(pid);
    if (!isNode(name)) {
      console.log(
        `${port} (${app}): skipped PID ${pid}, not node (${name || 'unknown'})`,
      );
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
      killed.add(pid);
      console.log(`${port} (${app}): killed PID ${pid}`);
    } catch (error) {
      console.error(
        `${port} (${app}): could not kill PID ${pid} (${error.code})`,
      );
    }
  }
}
console.log(killed.size ? 'Ports cleared' : 'Nothing was listening');
