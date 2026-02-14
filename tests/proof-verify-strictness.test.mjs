import test from 'node:test';
import assert from 'node:assert/strict';

import { validateProofSpotChecks } from '../lib/proof-verify.js';

function mkProof(overrides = {}) {
  return {
    from_beat: 10,
    to_beat: 13,
    from_hash: 'a'.repeat(64),
    to_hash: 'b'.repeat(64),
    beats_computed: 3,
    spot_checks: [
      { index: 11, hash: 'x'.repeat(64), prev: 'y'.repeat(64), timestamp: 1, nonce: 0 },
      { index: 12, hash: 'm'.repeat(64), prev: 'n'.repeat(64), timestamp: 1, nonce: 0 },
      { index: 13, hash: 'p'.repeat(64), prev: 'q'.repeat(64), timestamp: 1, nonce: 0 },
    ],
    ...overrides,
  };
}

test('proof mode rejects empty spot checks', async () => {
  const data = validateProofSpotChecks(mkProof({ spot_checks: [] }));
  assert.equal(data.valid, false);
  assert.match(String(data.reason), /At least 3 spot checks are required/);
});

test('proof mode rejects sparse spot checks below minimum', async () => {
  const data = validateProofSpotChecks(mkProof({
    spot_checks: [
      { index: 11, hash: 'x'.repeat(64), prev: 'y'.repeat(64), timestamp: 1, nonce: 0 },
      { index: 13, hash: 'p'.repeat(64), prev: 'q'.repeat(64), timestamp: 1, nonce: 0 },
    ],
  }));
  assert.equal(data.valid, false);
  assert.match(String(data.reason), /At least 3 spot checks are required/);
});

test('proof mode rejects spot checks missing endpoint to_beat', async () => {
  const data = validateProofSpotChecks(mkProof({
    spot_checks: [
      { index: 10, hash: 'x'.repeat(64), prev: 'y'.repeat(64), timestamp: 1, nonce: 0 },
      { index: 11, hash: 'm'.repeat(64), prev: 'n'.repeat(64), timestamp: 1, nonce: 0 },
      { index: 12, hash: 'p'.repeat(64), prev: 'q'.repeat(64), timestamp: 1, nonce: 0 },
    ],
  }));
  assert.equal(data.valid, false);
  assert.match(String(data.reason), /must include endpoint to_beat/);
});

test('proof mode accepts proof with minimum checks and endpoint coverage', async () => {
  const data = validateProofSpotChecks(mkProof());
  assert.equal(data.valid, true);
});
