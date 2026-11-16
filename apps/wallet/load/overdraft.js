// Spec acceptance test 2, no overdraft under load: A has $100.00; 200 VUs each send $1.00 to B
// at once. Exactly 100 succeed, the other 100 are refused, A ends at 0, B at $100.00, and the
// audit (which recomputes every balance from the entries) finds nothing.
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
const refused = new Counter('transfers_refused_insufficient');
const other = new Counter('transfers_other');

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
    transfers_ok: ['count==100'],
    transfers_refused_insufficient: ['count==100'],
    transfers_other: ['count==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  return { a: newUser('overdraft-a', 100), b: newUser('overdraft-b', 0) };
}

export default function ({ a, b }) {
  const result = transfer(a, b.email, 100, uniqueKey());
  if (result.outcome === 'ok') {
    ok.add(1);
  } else if (result.message === 'amount exceeds your available balance') {
    refused.add(1);
  } else {
    other.add(1);
    console.error(
      `unexpected: ${result.outcome} ${result.message || result.response.body}`,
    );
  }
}

export function teardown({ a, b }) {
  check(null, {
    'A ends at 0': () => available(a) === '0',
    'B ends at $100.00': () => available(b) === '10000',
    'audit finds nothing': () => auditIssues().length === 0,
  });
}
