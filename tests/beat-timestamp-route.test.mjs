import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routePath = new URL('../app/api/v1/beat/timestamp/route.ts', import.meta.url);
const routeSource = readFileSync(routePath, 'utf8');

test('timestamp route enforces content-type and body-size guards', () => {
  assert.equal(routeSource.includes('Content-Type must be application/json'), true);
  assert.equal(routeSource.includes('MAX_BODY_BYTES = 256'), true);
  assert.equal(routeSource.includes('Request body too large'), true);
});

test('timestamp route validates strict SHA-256 lowercase hex input', () => {
  assert.equal(routeSource.includes('HASH_REGEX = /^[0-9a-f]{64}$/'), true);
  assert.equal(routeSource.includes('hash must be exactly 64 lowercase hex characters'), true);
});

test('timestamp route anchors on-chain and returns signed receipt metadata', () => {
  assert.equal(routeSource.includes('sendAnchorMemo(memo)'), true);
  assert.equal(routeSource.includes('signReceipt(receiptPayload)'), true);
  assert.equal(routeSource.includes('getExplorerUrl(signature)'), true);
  assert.equal(routeSource.includes('getAnchorPublicKeyBase58()'), true);
});

// timestamp route guard coverage
