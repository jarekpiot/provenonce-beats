import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routePath = new URL('../app/api/v1/beat/verify/route.ts', import.meta.url);
const routeSource = readFileSync(routePath, 'utf8');

test('public beat verify route caps difficulty and spot checks', () => {
  assert.equal(routeSource.includes('PUBLIC_MAX_DIFFICULTY'), true);
  assert.equal(routeSource.includes('PUBLIC_MAX_SPOT_CHECKS'), true);
  assert.equal(routeSource.includes('Too many spot checks'), true);
});

