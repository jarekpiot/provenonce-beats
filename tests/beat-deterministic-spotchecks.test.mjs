import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const beatPath = new URL('../lib/beat.ts', import.meta.url);
const beatSource = readFileSync(beatPath, 'utf8');

test('verifyBeatChain does not use Math.random (anti-retry deterministic sampling)', () => {
  // We still allow randomness in proof creation helpers (createCheckinProof),
  // but verification must be deterministic per input to avoid retry abuse.
  assert.equal(beatSource.includes('Math.random() * beats.length'), false);
  assert.equal(beatSource.includes('Deterministic spot checks (anti-retry):'), true);
});

test('createCheckinProof includes endpoint spot check at to_beat', () => {
  assert.equal(beatSource.includes('Always include the endpoint beat'), true);
  assert.equal(beatSource.includes('end.index === toBeat'), true);
  assert.equal(beatSource.includes('spotChecks.push({ index: end.index'), true);
});

