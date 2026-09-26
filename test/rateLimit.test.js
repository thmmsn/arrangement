import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rateLimit } from '../src/rateLimit.js';

function fakeRequest(limiter, ip) {
  let status = 200;
  const res = {
    set() { return res; },
    status(code) { status = code; return res; },
    json() { return res; },
  };
  let passed = false;
  limiter({ ip }, res, () => { passed = true; });
  return passed ? 200 : status;
}

test('stopper en IP-adresse etter maks antall forespørsler, men ikke andre', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 3 });
  assert.deepEqual([1, 2, 3, 4].map(() => fakeRequest(limiter, '1.1.1.1')), [200, 200, 200, 429]);
  assert.equal(fakeRequest(limiter, '2.2.2.2'), 200);
});
