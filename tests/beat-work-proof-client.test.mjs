/**
 * Phase 2B — Beats Client Work Proof Tests
 *
 * Tests submitWorkProof() and verifyWorkProofReceipt() using mock fetch.
 * No live network calls — all responses are fabricated with real Ed25519 signing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createBeatsClient } from '../sdk/beats-client/index.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function canonicalJson(value) {
  const keys = Object.keys(value).sort();
  const out = {};
  for (const key of keys) out[key] = value[key];
  return JSON.stringify(out);
}

/** Generate an ephemeral Ed25519 keypair for test signing. */
function makeTestKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubHex = Buffer.from(spki).subarray(-32).toString('hex');
  return { privateKey, pubHex };
}

/** Build a signed work-proof receipt payload. */
function signPayload(payload, privateKey) {
  return sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
}

/** Compute a single beat hash (matches lib/beat.ts computeBeat formula). */
function computeBeatHash(prev, beatIndex, difficulty = 1000, anchorHash) {
  const seed = anchorHash
    ? `${prev}:${beatIndex}::${anchorHash}`
    : `${prev}:${beatIndex}:`;
  let current = createHash('sha256').update(seed, 'utf8').digest('hex');
  for (let i = 0; i < difficulty; i++) {
    current = createHash('sha256').update(current, 'utf8').digest('hex');
  }
  return current;
}

/** Build a minimal valid work-proof request (3 spot checks, difficulty 1000). */
function buildValidProof() {
  const difficulty = 1000;
  const genesis = '0'.repeat(64);
  // Compute 3 beats to get valid spot checks
  const h1 = computeBeatHash(genesis, 0, difficulty);
  const h2 = computeBeatHash(h1, 1, difficulty);
  const h3 = computeBeatHash(h2, 2, difficulty);
  return {
    from_hash: genesis,
    to_hash: h3,
    beats_computed: 3,
    difficulty,
    anchor_index: 100,
    spot_checks: [
      { index: 0, hash: h1, prev: genesis },
      { index: 1, hash: h2, prev: h1 },
      { index: 2, hash: h3, prev: h2 },
    ],
  };
}

/** Wrap a JSON response value into a mock Response object (matching beats-client's request() expectations). */
function mockResponse(data, ok = true, status = 200) {
  const body = JSON.stringify(data);
  return {
    ok,
    status,
    text: async () => body,
  };
}

/** Create a mock beats client pointing at a fake server. */
function makeMockClient(fetchImpl) {
  return createBeatsClient({
    baseUrl: 'https://beats.example.com',
    fetchImpl,
    timeoutMs: 0, // disable timeout for tests
  });
}

/** Build a successful work-proof server response with a real Ed25519 signature. */
function makeSuccessResponse(keypair, overrides = {}) {
  const { privateKey, pubHex } = keypair;
  const payload = {
    type: 'work_proof',
    beats_verified: 3,
    difficulty: 1000,
    anchor_index: 100,
    anchor_hash: null,
    from_hash: '0'.repeat(64),
    to_hash: 'a'.repeat(64),
    utc: '2026-02-22T12:00:00.000Z',
    ...overrides,
  };
  const signature = signPayload(payload, privateKey);
  return {
    valid: true,
    receipt: { ...payload, signature },
  };
}

// ── submitWorkProof tests ────────────────────────────────────────────────────

test('submitWorkProof wraps proof in work_proof envelope', async () => {
  let capturedBody;
  const fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return mockResponse({ valid: true, receipt: {} });
  };
  const client = makeMockClient(fetch);
  const proof = buildValidProof();
  await client.submitWorkProof(proof);
  assert.ok(capturedBody.work_proof, 'request body must have work_proof wrapper');
  assert.deepEqual(capturedBody.work_proof, proof, 'work_proof must contain the original proof');
  assert.equal(capturedBody.from_hash, undefined, 'top-level must not have flat from_hash');
});

test('submitWorkProof sends POST to /api/v1/beat/work-proof', async () => {
  let capturedUrl;
  const fetch = async (url, opts) => {
    capturedUrl = url;
    return mockResponse({ valid: false, reason: 'stale_anchor' });
  };
  const client = makeMockClient(fetch);
  await client.submitWorkProof(buildValidProof());
  assert.ok(capturedUrl.includes('/api/v1/beat/work-proof'), 'must POST to correct endpoint');
});

test('submitWorkProof sends content-type application/json', async () => {
  let capturedHeaders;
  const fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return mockResponse({ valid: false, reason: 'stale_anchor' });
  };
  const client = makeMockClient(fetch);
  await client.submitWorkProof(buildValidProof());
  assert.equal(capturedHeaders['content-type'], 'application/json', 'must set application/json content-type');
});

test('submitWorkProof returns valid:false response unchanged', async () => {
  const fetch = async () => mockResponse({ valid: false, reason: 'spot_check_failed' });
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  assert.equal(result.valid, false, 'should propagate valid:false');
  assert.equal(result.reason, 'spot_check_failed', 'should propagate reason');
});

test('submitWorkProof returns valid:true with receipt on success', async () => {
  const kp = makeTestKeypair();
  const serverResponse = makeSuccessResponse(kp);
  const fetch = async () => mockResponse(serverResponse);
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  assert.equal(result.valid, true, 'should return valid:true');
  assert.ok(result.receipt, 'should return receipt');
  assert.equal(result.receipt.type, 'work_proof', 'receipt type must be work_proof');
  assert.equal(typeof result.receipt.signature, 'string', 'receipt must have signature');
  assert.equal(typeof result.receipt.utc, 'string', 'utc must be a string (ISO)');
});

// ── verifyWorkProofReceipt tests ─────────────────────────────────────────────

test('verifyWorkProofReceipt returns true for valid signature with pinned key', async () => {
  const kp = makeTestKeypair();
  const serverResponse = makeSuccessResponse(kp);
  const fetch = async () => mockResponse(serverResponse);
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  const valid = await client.verifyWorkProofReceipt(result, { publicKey: kp.pubHex });
  assert.equal(valid, true, 'valid signature should verify');
});

test('verifyWorkProofReceipt returns false for wrong signature', async () => {
  const kp = makeTestKeypair();
  const kp2 = makeTestKeypair(); // different keypair
  const serverResponse = makeSuccessResponse(kp);
  // Replace signature with one signed by a different key
  serverResponse.receipt.signature = signPayload(
    { different: 'payload' },
    kp2.privateKey,
  );
  const fetch = async () => mockResponse(serverResponse);
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  const valid = await client.verifyWorkProofReceipt(result, { publicKey: kp.pubHex });
  assert.equal(valid, false, 'wrong signature should not verify');
});

test('verifyWorkProofReceipt returns false for tampered receipt field', async () => {
  const kp = makeTestKeypair();
  const serverResponse = makeSuccessResponse(kp);
  const fetch = async () => mockResponse(serverResponse);
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  // Tamper with a field after signing
  result.receipt.beats_verified = 999999;
  const valid = await client.verifyWorkProofReceipt(result, { publicKey: kp.pubHex });
  assert.equal(valid, false, 'tampered field should break verification');
});

test('verifyWorkProofReceipt returns false for missing signature', async () => {
  const kp = makeTestKeypair();
  const serverResponse = makeSuccessResponse(kp);
  delete serverResponse.receipt.signature;
  const fetch = async () => mockResponse(serverResponse);
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  const valid = await client.verifyWorkProofReceipt(result, { publicKey: kp.pubHex });
  assert.equal(valid, false, 'missing signature should return false');
});

test('verifyWorkProofReceipt returns false for null/undefined receipt', async () => {
  const client = makeMockClient(async () => mockResponse({}));
  const valid = await client.verifyWorkProofReceipt(null, { publicKey: 'a'.repeat(64) });
  assert.equal(valid, false, 'null response should return false');
  const valid2 = await client.verifyWorkProofReceipt({ valid: true }, { publicKey: 'a'.repeat(64) });
  assert.equal(valid2, false, 'missing receipt should return false');
});

test('verifyWorkProofReceipt fetches work_proof key from /key endpoint when not pinned', async () => {
  const kp = makeTestKeypair();
  const serverResponse = makeSuccessResponse(kp);
  let keyEndpointCalled = false;
  const fetch = async (url) => {
    if (url.includes('/api/v1/beat/key')) {
      keyEndpointCalled = true;
      return mockResponse({
        public_key_base58: 'ignored',
        keys: {
          timestamp: { public_key_hex: 'ee'.repeat(32) },
          work_proof: { public_key_hex: kp.pubHex },
        },
      });
    }
    return mockResponse(serverResponse);
  };
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  const valid = await client.verifyWorkProofReceipt(result);
  assert.equal(keyEndpointCalled, true, 'should fetch /key when no pinned key');
  assert.equal(valid, true, 'should verify using auto-fetched key');
});

test('verifyWorkProofReceipt uses work_proof key not timestamp key', async () => {
  const timestampKp = makeTestKeypair(); // wrong key
  const workProofKp = makeTestKeypair(); // correct key
  const serverResponse = makeSuccessResponse(workProofKp);
  const fetch = async (url) => {
    if (url.includes('/api/v1/beat/key')) {
      return mockResponse({
        // Timestamp key is different from work_proof key
        public_key_hex: timestampKp.pubHex,
        keys: {
          timestamp: { public_key_hex: timestampKp.pubHex },
          work_proof: { public_key_hex: workProofKp.pubHex },
        },
      });
    }
    return mockResponse(serverResponse);
  };
  const client = makeMockClient(fetch);
  const result = await client.submitWorkProof(buildValidProof());
  const valid = await client.verifyWorkProofReceipt(result);
  assert.equal(valid, true, 'must use work_proof key (not timestamp key) for verification');
});

// ── Canonical JSON consistency ────────────────────────────────────────────────

test('canonical JSON sorts keys deterministically', () => {
  const payload1 = { utc: '2026-02-22', type: 'work_proof', beats_verified: 100, anchor_index: 5 };
  const payload2 = { beats_verified: 100, anchor_index: 5, type: 'work_proof', utc: '2026-02-22' };
  const json1 = canonicalJson(payload1);
  const json2 = canonicalJson(payload2);
  assert.equal(json1, json2, 'canonical JSON must sort keys and be order-independent');
});

test('signature excludes the signature field itself (payload = receipt without signature)', async () => {
  const kp = makeTestKeypair();
  const payload = {
    type: 'work_proof',
    beats_verified: 50,
    difficulty: 1000,
    anchor_index: 10,
    anchor_hash: null,
    from_hash: '0'.repeat(64),
    to_hash: 'f'.repeat(64),
    utc: '2026-02-22T00:00:00.000Z',
  };
  const sig = signPayload(payload, kp.privateKey);
  const receipt = { ...payload, signature: sig };

  // Extract signature, verify rest of receipt
  const { signature, ...payloadToVerify } = receipt;
  assert.ok(!Object.keys(payloadToVerify).includes('signature'), 'payload for verification must not include signature field');
  assert.ok(Object.keys(receipt).includes('signature'), 'receipt must have signature field');

  // Verify signature matches payload (without signature field)
  const messageBytes = Buffer.from(canonicalJson(payloadToVerify), 'utf8');
  const signatureBytes = Buffer.from(signature, 'base64');
  const { verify } = await import('node:crypto');
  const { createPublicKey } = await import('node:crypto');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const pubKeyHex = Buffer.from(kp.pubHex, 'hex');
  const pubDer = Buffer.concat([spkiPrefix, pubKeyHex]);
  const pubKey = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  const isValid = verify(null, messageBytes, pubKey, signatureBytes);
  assert.equal(isValid, true, 'signature must verify against payload-without-signature');
});
