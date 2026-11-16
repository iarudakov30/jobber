// Spec acceptance test 3, deadlock-free: A and B have $100.00 each; 100 VUs send $1.00 A → B
// while 100 send $1.00 B → A, all at once. Every transfer succeeds (no deadlock errors) and both
// end where they started.
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import {
  auditIssues,
  available,
  newUser,
  transfer,
  uniqueKey,
} from './lib.js';

const ok = new Counter('transfers_ok');
const failed = new Counter('transfers_failed');

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: 200,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    transfers_ok: ['count==200'],
    transfers_failed: ['count==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  return { a: newUser('deadlock-a', 100), b: newUser('deadlock-b', 100) };
}

export default function ({ a, b }) {
  const [from, to] = __VU % 2 ? [a, b] : [b, a];
  const result = transfer(from, to.email, 100, uniqueKey());
  if (result.outcome === 'ok') {
    ok.add(1);
  } else {
    failed.add(1);
    console.error(
      `failed: ${result.outcome} ${result.message || result.response.body}`,
    );
  }
}

export function teardown({ a, b }) {
  check(null, {
    'A back at $100.00': () => available(a) === '10000',
    'B back at $100.00': () => available(b) === '10000',
    'audit finds nothing': () => auditIssues().length === 0,
  });
}
