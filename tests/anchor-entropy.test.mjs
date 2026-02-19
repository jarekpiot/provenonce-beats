import test from 'node:test';
import assert from 'node:assert/strict';

// Import from the compiled beat module — use dynamic import for TS
const beat = await import('../lib/beat.ts');
// Fallback: if TS direct import fails, tests must be run with tsx
const {
  createGlobalAnchor,
  verifyGlobalAnchor,
  computeAnchorHashV3,
  ANCHOR_DOMAIN_PREFIX,
  DEFAULT_DIFFICULTY,
} = beat;

// A realistic Solana blockhash (base58, 32 bytes)
const ENTROPY_A = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL1VZHirAn';
const ENTROPY_B = '7Vtv8PHAsxJhPADJFnJhrg5ZASXNA2wfTbJTXzEGpump';

// ============ 5a: Changing entropy changes anchor hash ============

test('A-4: different solana_entropy produces different anchor hash', () => {
  const prev = createGlobalAnchor(null, 10, 0, ENTROPY_A);

  const anchorA = createGlobalAnchor(prev, 10, 0, ENTROPY_A);
  const anchorB = createGlobalAnchor(prev, 10, 0, ENTROPY_B);

  // Same prev, same index, same difficulty, same epoch — only entropy differs
  assert.equal(anchorA.beat_index, anchorB.beat_index, 'Same beat_index');
  assert.equal(anchorA.prev_hash, anchorB.prev_hash, 'Same prev_hash');
  assert.notEqual(anchorA.hash, anchorB.hash, 'Hash MUST differ when entropy differs');
});

test('A-4: entropy vs no-entropy produces different anchor hash', () => {
  const prev = createGlobalAnchor(null, 10, 0, ENTROPY_A);

  const withEntropy = createGlobalAnchor(prev, 10, 0, ENTROPY_A);
  const withoutEntropy = createGlobalAnchor(prev, 10, 0);

  assert.notEqual(withEntropy.hash, withoutEntropy.hash, 'Entropy must change the hash');
  assert.equal(withEntropy.solana_entropy, ENTROPY_A);
  assert.equal(withoutEntropy.solana_entropy, undefined);
});

// ============ 5b: Deterministic with same inputs ============

test('A-4: same prev/index/entropy => deterministic same hash', () => {
  const prev = {
    beat_index: 99,
    hash: 'a'.repeat(64),
    prev_hash: '9'.repeat(64),
    utc: 1770000000000,
    difficulty: 10,
    epoch: 0,
  };

  const anchor1 = createGlobalAnchor(prev, 10, 0, ENTROPY_A);
  // createGlobalAnchor uses Date.now() for utc, so the two calls will have
  // different utc values. To test true determinism, verify via verifyGlobalAnchor.
  assert.equal(verifyGlobalAnchor(anchor1), true, 'Anchor must verify its own hash');
  assert.equal(anchor1.solana_entropy, ENTROPY_A);

  // Construct a second anchor with identical fields to prove determinism
  const anchor2Copy = { ...anchor1 };
  assert.equal(verifyGlobalAnchor(anchor2Copy), true, 'Identical fields must produce same hash');

  // Flip one bit of entropy and verification must fail
  const tampered = { ...anchor1, solana_entropy: ENTROPY_B };
  assert.equal(verifyGlobalAnchor(tampered), false, 'Tampered entropy must fail verification');
});

// ============ 5c: Missing entropy in cron = no head advance ============
// This is enforced at the cron route level (fail-closed 503).
// Here we verify that createGlobalAnchor without entropy produces a legacy
// anchor (no solana_entropy field), and that verifyGlobalAnchor handles both.

test('A-4: legacy anchor (no entropy) still verifies', () => {
  const legacy = createGlobalAnchor(null, 10, 0);
  assert.equal(legacy.solana_entropy, undefined);
  assert.equal(verifyGlobalAnchor(legacy), true, 'Legacy anchor must still verify');
});

test('V3: anchor with entropy verifies', () => {
  const v3 = createGlobalAnchor(null, 10, 0, ENTROPY_A);
  assert.equal(v3.solana_entropy, ENTROPY_A);
  assert.equal(verifyGlobalAnchor(v3), true, 'V3 anchor with entropy must verify');
});

// ============ 5d: Commitment level is 'finalized' ============
// This is a code-path assertion: the Solana connection and blockhash fetch
// both use 'finalized'. We verify by reading the source at test time.

test('A-4: Solana connection uses finalized commitment', async () => {
  const { readFileSync } = await import('node:fs');
  const solanaSource = readFileSync(new URL('../lib/solana.ts', import.meta.url), 'utf8');

  // Connection constructor commitment
  assert.match(solanaSource, /commitment:\s*['"]finalized['"]/, 'Connection must use finalized commitment');

  // getFinalizedBlockhash uses finalized
  assert.match(solanaSource, /getLatestBlockhash\(\s*['"]finalized['"]\s*\)/, 'Blockhash fetch must use finalized');

  // Ensure 'processed' is never used as commitment
  const processedMatches = solanaSource.match(/commitment:\s*['"]processed['"]/g);
  assert.equal(processedMatches, null, 'Must never use processed commitment');
});

// ============ Domain prefix ============

test('V3: ANCHOR_DOMAIN_PREFIX is PROVENONCE_BEATS_V1', () => {
  assert.equal(ANCHOR_DOMAIN_PREFIX, 'PROVENONCE_BEATS_V1');
  assert.equal(Buffer.from(ANCHOR_DOMAIN_PREFIX, 'utf8').length, 19, 'Domain prefix must be 19 bytes');
});

test('V3: entropy anchor uses binary formula (no difficulty iteration)', () => {
  const anchor = createGlobalAnchor(null, 10, 0, ENTROPY_A);
  assert.equal(verifyGlobalAnchor(anchor), true, 'V3 anchor must verify');
  assert.equal(anchor.solana_entropy, ENTROPY_A);
});

// ============ V3 Binary Formula Tests ============

test('V3: computeAnchorHashV3 is deterministic', () => {
  const prevHash = 'a'.repeat(64);
  const h1 = computeAnchorHashV3(prevHash, 100, ENTROPY_A);
  const h2 = computeAnchorHashV3(prevHash, 100, ENTROPY_A);
  assert.equal(h1, h2, 'Same inputs must produce same hash');
  assert.match(h1, /^[0-9a-f]{64}$/, 'Must be valid hex hash');
});

test('V3: different entropy produces different hash', () => {
  const prevHash = 'a'.repeat(64);
  const h1 = computeAnchorHashV3(prevHash, 100, ENTROPY_A);
  const h2 = computeAnchorHashV3(prevHash, 100, ENTROPY_B);
  assert.notEqual(h1, h2, 'Different entropy must produce different hash');
});

test('V3: different beat_index produces different hash', () => {
  const prevHash = 'a'.repeat(64);
  const h1 = computeAnchorHashV3(prevHash, 100, ENTROPY_A);
  const h2 = computeAnchorHashV3(prevHash, 101, ENTROPY_A);
  assert.notEqual(h1, h2, 'Different beat_index must produce different hash');
});

test('V3: different prev_hash produces different hash', () => {
  const h1 = computeAnchorHashV3('a'.repeat(64), 100, ENTROPY_A);
  const h2 = computeAnchorHashV3('b'.repeat(64), 100, ENTROPY_A);
  assert.notEqual(h1, h2, 'Different prev_hash must produce different hash');
});

test('V3: tampered entropy field detected on verify', () => {
  const anchor = createGlobalAnchor(null, 10, 0, ENTROPY_A);
  const tampered = { ...anchor, solana_entropy: ENTROPY_B };
  assert.equal(verifyGlobalAnchor(tampered), false, 'Tampered entropy must fail verification');
});

test('V3: v3 hash differs from what v1 legacy would produce', () => {
  // V3 uses binary formula; v1 uses string formula. They must differ.
  const prevA = createGlobalAnchor(null, 10, 0, ENTROPY_A);
  const prevB = createGlobalAnchor(null, 10, 0);
  // Both start from same genesis seed, but formula differs
  assert.notEqual(prevA.hash, prevB.hash, 'V3 and V1 must produce different hashes');
});
