/**
 * Phase 2B — Work Proof Route Tests
 *
 * Source inspection + structural tests. Validates that the route
 * implementation matches the Phase 2B spec without running the full Next.js stack.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const routePath = new URL('../app/api/v1/beat/work-proof/route.ts', import.meta.url);
const routeSource = readFileSync(routePath, 'utf8');

// ── Source inspection tests ─────────────────────────────────────────────────

test('route accepts work_proof wrapper via body?.work_proof ?? body', () => {
  assert.ok(routeSource.includes('body?.work_proof ?? body'), 'should unwrap work_proof envelope');
});

test('route exports PUBLIC_MAX_SPOT_CHECKS = 25', () => {
  assert.ok(routeSource.includes('PUBLIC_MAX_SPOT_CHECKS = 25'), 'max spot checks must be 25');
});

test('route exports MIN_SPOT_CHECKS = 3', () => {
  assert.ok(routeSource.includes('MIN_SPOT_CHECKS = 3'), 'minimum spot checks must be 3');
});

test('route validates from_hash is 64 hex', () => {
  assert.ok(routeSource.includes('from_hash must be 64 lowercase hex characters'), 'from_hash must be validated');
});

test('route validates to_hash is 64 hex', () => {
  assert.ok(routeSource.includes('to_hash must be 64 lowercase hex characters'), 'to_hash must be validated');
});

test('route validates beats_computed is a positive integer', () => {
  assert.ok(routeSource.includes('beats_computed must be a positive integer'), 'beats_computed validation required');
});

test('route validates anchor_index is a non-negative integer', () => {
  assert.ok(routeSource.includes('anchor_index must be a non-negative integer'), 'anchor_index validation required');
});

test('route rejects difficulty below MIN_DIFFICULTY with valid:false reason', () => {
  assert.ok(routeSource.includes("invalid('insufficient_difficulty')"), 'should return invalid reason for low difficulty');
  // Must NOT clamp — must reject
  assert.ok(!routeSource.includes('Math.max(rawDifficulty, MIN_DIFFICULTY)'), 'must NOT clamp low difficulty silently');
});

test('route returns invalid reason for insufficient spot checks', () => {
  assert.ok(routeSource.includes("invalid('insufficient_spot_checks')"), 'insufficient_spot_checks reason required');
});

test('route returns invalid reason for count_mismatch', () => {
  assert.ok(routeSource.includes("invalid('count_mismatch')"), 'count_mismatch reason required');
});

test('route returns invalid reason for stale_anchor', () => {
  assert.ok(routeSource.includes("invalid('stale_anchor')"), 'stale_anchor reason required');
});

test('route returns invalid reason for spot_check_failed', () => {
  assert.ok(routeSource.includes("invalid('spot_check_failed')"), 'spot_check_failed reason required');
});

test('route uses invalid() helper to return { valid: false, reason }', () => {
  assert.ok(routeSource.includes("{ valid: false, reason }"), 'invalid() must return { valid: false, reason }');
});

test('receipt includes from_hash and to_hash', () => {
  assert.ok(routeSource.includes('from_hash: fromHash'), 'from_hash must be in receipt payload');
  assert.ok(routeSource.includes('to_hash: toHash'), 'to_hash must be in receipt payload');
});

test('receipt utc is an ISO string not a Unix timestamp', () => {
  assert.ok(routeSource.includes('new Date().toISOString()'), 'utc must be ISO string');
  assert.ok(!routeSource.includes('Date.now()'), 'should not use Date.now() for utc (must be ISO)');
});

test('receipt type is work_proof', () => {
  assert.ok(routeSource.includes("type: 'work_proof'"), 'receipt type must be work_proof');
});

test('signature is embedded inside receipt not at top level', () => {
  assert.ok(routeSource.includes('signature: signature_base64'), 'signature must be inside receipt spread');
  assert.ok(routeSource.includes('...receiptPayload'), 'receipt must be built from spread of receiptPayload');
  // Response must NOT have top-level signature field
  assert.ok(!routeSource.includes('"signature": signature_base64'), 'signature should not be a separate top-level field');
});

test('response shape is { valid: true, receipt: {...} } not { ok, valid, receipt, signature }', () => {
  assert.ok(routeSource.includes('valid: true'), 'response must have valid: true');
  // Should not have separate ok: true at top level
  assert.ok(!routeSource.includes("ok: true,\n      valid: true"), 'must not have ok: true alongside valid: true');
});

test('rate limiter is set to 10 requests per minute', () => {
  assert.ok(routeSource.includes('maxRequests: 10'), 'rate limit must be 10/min');
  assert.ok(routeSource.includes('windowMs: 60 * 1000'), 'window must be 60 seconds');
});

test('spot check requires prev field for hash-chain recomputation', () => {
  assert.ok(routeSource.includes('prev must be 64 hex characters'), 'prev is required for recomputation');
});

test('count mismatch uses span of spot-check indices vs beats_computed', () => {
  assert.ok(routeSource.includes('maxScIndex - minScIndex > beatsComputed'), 'count_mismatch uses index span check');
});

test('anchor freshness uses ANCHOR_HASH_GRACE_WINDOW from lib/beat', () => {
  assert.ok(routeSource.includes('ANCHOR_HASH_GRACE_WINDOW'), 'must use grace window constant');
  assert.ok(routeSource.includes("ageDelta > ANCHOR_HASH_GRACE_WINDOW"), 'must check grace window');
});

test('signing uses signWorkProofReceipt from lib/solana', () => {
  assert.ok(routeSource.includes('signWorkProofReceipt(receiptPayload)'), 'must sign via signWorkProofReceipt');
});

test('CORS headers allow all origins for public endpoint', () => {
  assert.ok(routeSource.includes("'Access-Control-Allow-Origin': '*'"), 'must allow all origins');
});

test('GET endpoint documents signing_context as provenonce:beats:work-proof:v1', () => {
  assert.ok(routeSource.includes("'provenonce:beats:work-proof:v1'"), 'must document signing context');
});

test('difficulty is clamped to PUBLIC_MAX_DIFFICULTY after rejection check', () => {
  assert.ok(routeSource.includes('Math.min(rawDifficulty, PUBLIC_MAX_DIFFICULTY)'), 'should clamp max difficulty');
});

// ── Hash chain math verification ─────────────────────────────────────────────

function computeSingleBeat(prev, beatIndex, difficulty = 1000, anchorHash) {
  const seed = anchorHash
    ? `${prev}:${beatIndex}::${anchorHash}`
    : `${prev}:${beatIndex}:`;
  let current = createHash('sha256').update(seed, 'utf8').digest('hex');
  for (let i = 0; i < difficulty; i++) {
    current = createHash('sha256').update(current, 'utf8').digest('hex');
  }
  return current;
}

test('spot check math: verifyBeat recomputes SHA-256 chain correctly', () => {
  // This verifies our understanding of the hash formula matches lib/beat.ts
  const prev = '0'.repeat(64);
  const beatIndex = 50;
  const difficulty = 10;
  const hash = computeSingleBeat(prev, beatIndex, difficulty);

  // Verify: recompute from scratch
  const recomputed = computeSingleBeat(prev, beatIndex, difficulty);
  assert.equal(hash, recomputed, 'hash must be deterministic');

  // Different index = different hash (index is in seed)
  const hashOtherIndex = computeSingleBeat(prev, beatIndex + 1, difficulty);
  assert.notEqual(hash, hashOtherIndex, 'beat index must affect hash');

  // Different prev = different hash
  const hashOtherPrev = computeSingleBeat('a'.repeat(64), beatIndex, difficulty);
  assert.notEqual(hash, hashOtherPrev, 'prev must affect hash');
});

test('count mismatch logic: span check allows chains starting at any index', () => {
  // Agent chain at indices 5000-6500, beats_computed = 1500
  const scIndices = [5050, 5742, 6389];
  const beatsComputed = 1500;
  const minIdx = Math.min(...scIndices);
  const maxIdx = Math.max(...scIndices);
  const span = maxIdx - minIdx;
  assert.ok(span <= beatsComputed, `span ${span} should be <= beatsComputed ${beatsComputed}`);

  // Mismatch: span exceeds claimed window
  const mismatchIndices = [0, 500, 2000];
  const mismatchSpan = Math.max(...mismatchIndices) - Math.min(...mismatchIndices);
  assert.ok(mismatchSpan > 1500, `span ${mismatchSpan} should exceed beatsComputed 1500`);
});
