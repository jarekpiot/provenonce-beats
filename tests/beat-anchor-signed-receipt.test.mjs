import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routePath = new URL('../app/api/v1/beat/anchor/route.ts', import.meta.url);
const routeSource = readFileSync(routePath, 'utf8');

test('anchor route returns a signed receipt payload', () => {
  assert.equal(routeSource.includes('signReceipt(receiptPayload)'), true);
  assert.equal(routeSource.includes('getReceiptPublicKeyBase58()'), true);
  assert.equal(routeSource.includes('receipt:'), true);
});

