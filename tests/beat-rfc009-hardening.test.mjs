import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const timestampRoutePath = new URL('../app/api/v1/beat/timestamp/route.ts', import.meta.url);
const timestampRouteSource = readFileSync(timestampRoutePath, 'utf8');
const middlewarePath = new URL('../middleware.ts', import.meta.url);
const middlewareSource = readFileSync(middlewarePath, 'utf8');

const solanaLibPath = new URL('../lib/solana.ts', import.meta.url);
const solanaLibSource = readFileSync(solanaLibPath, 'utf8');

test('timestamp route enforces both short-window and daily quotas', () => {
  assert.equal(timestampRouteSource.includes('const limiter = new RateLimiter({ maxRequests: 5'), true);
  assert.equal(timestampRouteSource.includes('const dailyLimiter = new RateLimiter({ maxRequests: 10'), true);
  assert.equal(timestampRouteSource.includes('const proLimiter = new RateLimiter({ maxRequests: 30'), true);
  assert.equal(timestampRouteSource.includes('const proDailyLimiter = new RateLimiter({ maxRequests: 500'), true);
  assert.equal(timestampRouteSource.includes('Daily timestamp quota exceeded'), true);
});

test('timestamp route uses cached anchor read path', () => {
  assert.equal(timestampRouteSource.includes('readLatestAnchorCached(10_000)'), true);
});

test('timestamp route supports optional pro tier token', () => {
  assert.equal(timestampRouteSource.includes('x-beats-tier-token'), true);
  assert.equal(timestampRouteSource.includes('isValidProTierToken'), true);
});

test('timestamp route checks anchor wallet balance before memo write', () => {
  assert.equal(timestampRouteSource.includes('getAnchorBalanceLamports()'), true);
  assert.equal(timestampRouteSource.includes('anchor wallet balance too low'), true);
});

test('receipt signing key is HKDF-derived from anchor key material', () => {
  assert.equal(solanaLibSource.includes('hkdfSync('), true);
  assert.equal(solanaLibSource.includes('RECEIPT_SIGNING_KEY_INFO'), true);
  assert.equal(solanaLibSource.includes('getReceiptPublicKeyBase58'), true);
});

test('api cors is centralized in middleware', () => {
  assert.equal(middlewareSource.includes("matcher: ['/api/:path*']"), true);
  assert.equal(middlewareSource.includes('Access-Control-Allow-Origin'), true);
  assert.equal(middlewareSource.includes("req.nextUrl.pathname.startsWith('/api/cron/')"), true);
});
// nonce 000423
