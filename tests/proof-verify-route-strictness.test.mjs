import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routePath = new URL('../app/api/v1/beat/verify/route.ts', import.meta.url);
const routeSource = readFileSync(routePath, 'utf8');

test('proof verification route delegates to strict verifier helper', () => {
  assert.equal(routeSource.includes('verifyCheckinProof(proof, difficulty)'), true);
});

test('proof verification route no longer uses permissive allValid default flow', () => {
  assert.equal(routeSource.includes('let allValid = true'), false);
  assert.equal(routeSource.includes('proof.spot_checks && Array.isArray(proof.spot_checks)'), false);
});
