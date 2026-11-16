// Spec acceptance tests 4 and 5 (and 6: run it again after `docker compose stop redis`).
// 50 VUs send the same $1.00 transfer with one Idempotency-Key at once: one transfer happens,
// every other request gets CONFLICT or the replayed result. Then the key is reused with a
// different amount: UNPROCESSABLE_ENTITY, and no money moves.
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { available, newUser, transfer } from './lib.js';

const ok = new Counter('same_key_ok');
const conflict = new Counter('same_key_conflict');
const other = new Counter('same_key_other');

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      maxDuration: '1m',
    },
  },
  thresholds: {
    same_key_ok: ['count>=1'],
    same_key_other: ['count==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  return {
    a: newUser('same-key-a', 100),
    b: newUser('same-key-b', 0),
    key: `k6-same-${Date.now()}`,
  };
}

export default function ({ a, b, key }) {
  const result = transfer(a, b.email, 100, key);
  if (result.outcome === 'ok') {
    ok.add(1);
  } else if (result.outcome === 'CONFLICT') {
    conflict.add(1);
  } else {
    other.add(1);
    console.error(
      `unexpected: ${result.outcome} ${result.message || result.response.body}`,
    );
  }
}

export function teardown({ a, b, key }) {
  check(null, {
    'exactly one transfer: B has $1.00': () => available(b) === '100',
    'A has $99.00': () => available(a) === '9900',
  });
  const reused = transfer(a, b.email, 200, key);
  check(reused, {
    'same key, different amount: UNPROCESSABLE_ENTITY': (r) =>
      r.outcome === 'UNPROCESSABLE_ENTITY',
    'and still one transfer': () => available(b) === '100',
  });
}
