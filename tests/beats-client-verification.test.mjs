import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createBeatsClient } from '../sdk/beats-client/index.mjs';

// ============ TEST HELPERS ============

function canonicalJson(value) {
  const keys = Object.keys(value).sort();
  const out = {};
  for (const key of keys) out[key] = value[key];
  return JSON.stringify(out);
}

function makeSignedResponse(payload) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pubHex = Buffer.from(spki).subarray(-32).toString('hex');
  const signature = sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64');
  return { pubHex, signature, privateKey, publicKey };
}

function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function computeAnchorHash(prevHash, beatIndex, utc, epoch, difficulty) {
  const nonce = `anchor:${utc}:${epoch}`;
  const seed = `${prevHash}:${beatIndex}:${nonce}`;
  let current = sha256(seed);
  for (let i = 0; i < difficulty; i++) {
    current = sha256(current);
  }
  return current;
}

const dummyFetch = async () => ({ ok: true, text: async () => '{}' });

// ============ B-1: KEY PINNING ============

test('B-1: verifyReceipt uses pinned key, not response-embedded key', async () => {
  const payload = {
    hash: 'a'.repeat(64),
    anchor_index: 123,
    anchor_hash: 'b'.repeat(64),
    utc: 1770000000000,
    tx_signature: 'sig123',
  };

  // Sign with key A
  const keyA = makeSignedResponse(payload);

  // Create client pinned to key A
  const client = createBeatsClient({ fetchImpl: dummyFetch, pinnedPublicKey: keyA.pubHex });

  // Response embeds key A — should pass
  const ok = await client.verifyReceipt({
    timestamp: payload,
    receipt: { signature: keyA.signature, public_key: keyA.pubHex },
  });
  assert.equal(ok, true, 'Should verify with pinned key matching signer');
});

test('B-1: verifyReceipt rejects when response signed by different key than pinned', async () => {
  const payload = {
    hash: 'c'.repeat(64),
    anchor_index: 456,
    anchor_hash: 'd'.repeat(64),
    utc: 1770000001000,
    tx_signature: 'sig456',
  };

  // Sign with key B
  const keyB = makeSignedResponse(payload);
  // Pin key A (different)
  const keyA = makeSignedResponse({ dummy: true });

  const client = createBeatsClient({ fetchImpl: dummyFetch, pinnedPublicKey: keyA.pubHex });

  // Response signed by key B but client pinned to key A
  const ok = await client.verifyReceipt({
    timestamp: payload,
    receipt: { signature: keyB.signature, public_key: keyB.pubHex },
  });
  assert.equal(ok, false, 'Should reject — signed by B, pinned to A');
});

test('B-1: verifyReceipt auto-fetches key when not pinned', async () => {
  const payload = {
    hash: 'e'.repeat(64),
    anchor_index: 789,
    anchor_hash: 'f'.repeat(64),
    utc: 1770000002000,
    tx_signature: 'sig789',
  };
  const { pubHex, signature } = makeSignedResponse(payload);

  let keyFetched = false;
  const fetchImpl = async (url) => {
    if (url.includes('/api/v1/beat/key')) {
      keyFetched = true;
      return {
        ok: true,
        text: async () => JSON.stringify({ public_key_hex: pubHex, public_key_base58: 'xxx', algorithm: 'Ed25519' }),
      };
    }
    return { ok: true, text: async () => '{}' };
  };

  const client = createBeatsClient({ fetchImpl });
  const ok = await client.verifyReceipt({
    timestamp: payload,
    receipt: { signature, public_key: 'wrong-embedded-key' },
  });
  assert.equal(keyFetched, true, 'Should have auto-fetched key');
  assert.equal(ok, true, 'Should verify against auto-fetched key');
});

test('B-1: getAnchor({ verify: true }) uses pinned key', async () => {
  const anchorPayload = {
    beat_index: 99,
    hash: 'c'.repeat(64),
    prev_hash: 'd'.repeat(64),
    utc: 1770000001000,
    difficulty: 1000,
    epoch: 0,
    tx_signature: 'sig-anchor',
  };
  const { pubHex, signature } = makeSignedResponse(anchorPayload);

  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      anchor: anchorPayload,
      receipt: { signature, public_key: pubHex },
      on_chain: { tx_signature: 'sig-anchor' },
    }),
  });

  const client = createBeatsClient({ fetchImpl, pinnedPublicKey: pubHex });
  const out = await client.getAnchor({ verify: true });
  assert.equal(out._verified_receipt, true);
});

// ============ B-1: TAMPER DETECTION ============

test('B-1: verifyReceipt fails on tampered payload', async () => {
  const payload = {
    hash: 'e'.repeat(64),
    anchor_index: 555,
    anchor_hash: 'f'.repeat(64),
    utc: 1770000002000,
    tx_signature: 'sig-tamper',
  };
  const { pubHex, signature } = makeSignedResponse(payload);
  const client = createBeatsClient({ fetchImpl: dummyFetch, pinnedPublicKey: pubHex });
  const tampered = { ...payload, hash: '0'.repeat(64) };
  const ok = await client.verifyReceipt({
    timestamp: tampered,
    receipt: { signature, public_key: pubHex },
  });
  assert.equal(ok, false, 'Should detect tampered payload');
});

// ============ B-2: ANCHOR CHAIN CONTINUITY ============

test('B-2: getAnchor detects anchor regression', async () => {
  let callCount = 0;
  const anchors = [
    { beat_index: 10, hash: 'a'.repeat(64), prev_hash: '9'.repeat(64), utc: 1770000000000, difficulty: 100, epoch: 0 },
    { beat_index: 8, hash: 'b'.repeat(64), prev_hash: '7'.repeat(64), utc: 1769999000000, difficulty: 100, epoch: 0 },
  ];

  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      anchor: anchors[callCount++],
      on_chain: { tx_signature: null },
    }),
  });

  const client = createBeatsClient({ fetchImpl });
  await client.getAnchor(); // beat_index 10
  await assert.rejects(
    () => client.getAnchor(), // beat_index 8 — regression
    { message: /regression/i },
    'Should reject anchor regression'
  );
});

test('B-2: getAnchor detects chain break on consecutive anchors', async () => {
  let callCount = 0;
  const anchors = [
    { beat_index: 10, hash: 'a'.repeat(64), prev_hash: '9'.repeat(64), utc: 1770000000000, difficulty: 100, epoch: 0 },
    { beat_index: 11, hash: 'b'.repeat(64), prev_hash: 'x'.repeat(64), utc: 1770000060000, difficulty: 100, epoch: 0 },
    // prev_hash should be 'a'.repeat(64) to link to index 10
  ];

  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      anchor: anchors[callCount++],
      on_chain: { tx_signature: null },
    }),
  });

  const client = createBeatsClient({ fetchImpl });
  await client.getAnchor(); // beat_index 10
  await assert.rejects(
    () => client.getAnchor(), // beat_index 11 with wrong prev_hash
    { message: /chain break/i },
    'Should detect prev_hash mismatch'
  );
});

test('B-2: getAnchor rejects non-consecutive forward jumps', async () => {
  let callCount = 0;
  const anchors = [
    { beat_index: 10, hash: 'a'.repeat(64), prev_hash: '9'.repeat(64), utc: 1770000000000, difficulty: 100, epoch: 0 },
    { beat_index: 15, hash: 'b'.repeat(64), prev_hash: 'e'.repeat(64), utc: 1770000300000, difficulty: 100, epoch: 0 },
  ];

  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      anchor: anchors[callCount++],
      on_chain: { tx_signature: null },
    }),
  });

  const client = createBeatsClient({ fetchImpl });
  await client.getAnchor(); // 10
  await assert.rejects(
    () => client.getAnchor(), // 15 — non-consecutive, rejected
    { message: /jump/i },
    'Should reject beat_index jump'
  );
  assert.equal(client.isBroken(), true, 'Client should be broken after jump');
});

test('B-2: setLastKnownAnchor seeds continuity state', async () => {
  const client = createBeatsClient({ fetchImpl: dummyFetch });

  client.setLastKnownAnchor({
    beat_index: 50,
    hash: 'a'.repeat(64),
    prev_hash: '9'.repeat(64),
    utc: 1770000000000,
    difficulty: 100,
    epoch: 0,
  });

  const last = client.getLastKnownAnchor();
  assert.equal(last.beat_index, 50);
  assert.equal(last.hash, 'a'.repeat(64));
});

// ============ B-2: PERSISTENCE + FAIL-CLOSED ============

test('B-2: restart loads persisted state and continues correctly', async () => {
  let savedState = null;
  const onStateChange = (s) => { savedState = { ...s }; };

  const anchor10 = { beat_index: 10, hash: 'a'.repeat(64), prev_hash: '9'.repeat(64), utc: 1770000000000, difficulty: 100, epoch: 0 };
  const anchor11 = { beat_index: 11, hash: 'b'.repeat(64), prev_hash: 'a'.repeat(64), utc: 1770000060000, difficulty: 100, epoch: 0 };

  // Session 1: establish state at beat_index 10
  const client1 = createBeatsClient({
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ anchor: anchor10, on_chain: { tx_signature: null } }),
    }),
    onStateChange,
  });
  await client1.getAnchor();
  assert.deepEqual(savedState, { beat_index: 10, hash: 'a'.repeat(64), agent_id: null });

  // Session 2: new client loads saved state, continues from beat_index 11
  const client2 = createBeatsClient({
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ anchor: anchor11, on_chain: { tx_signature: null } }),
    }),
    loadState: () => savedState,
    onStateChange,
  });
  const result = await client2.getAnchor();
  assert.equal(result.anchor.beat_index, 11);
  assert.deepEqual(savedState, { beat_index: 11, hash: 'b'.repeat(64), agent_id: null });
});

test('B-2: prev_hash mismatch fails closed until explicit resync', async () => {
  let callCount = 0;
  const anchors = [
    { beat_index: 10, hash: 'a'.repeat(64), prev_hash: '9'.repeat(64), utc: 1770000000000, difficulty: 100, epoch: 0 },
    { beat_index: 11, hash: 'b'.repeat(64), prev_hash: 'x'.repeat(64), utc: 1770000060000, difficulty: 100, epoch: 0 },
  ];

  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      anchor: anchors[Math.min(callCount++, 1)],
      on_chain: { tx_signature: null },
    }),
  });

  const client = createBeatsClient({ fetchImpl });
  await client.getAnchor(); // 10 OK

  // 11 with wrong prev_hash — breaks chain
  await assert.rejects(() => client.getAnchor(), { message: /chain break/i });
  assert.equal(client.isBroken(), true, 'Client should be broken');

  // Further calls fail with CHAIN_BROKEN (no silent recovery)
  await assert.rejects(() => client.getAnchor(), { message: /broken/i });

  // setLastKnownAnchor also blocked while broken
  assert.throws(
    () => client.setLastKnownAnchor({ beat_index: 11, hash: 'b'.repeat(64) }),
    { message: /broken/i },
  );

  // Explicit resync clears the broken state
  client.resync({ beat_index: 11, hash: 'b'.repeat(64), prev_hash: 'a'.repeat(64), utc: 1770000060000, difficulty: 100, epoch: 0 });
  assert.equal(client.isBroken(), false, 'Should be cleared after resync');
});

test('B-2: beat_index jump fails closed', async () => {
  let callCount = 0;
  const anchors = [
    { beat_index: 10, hash: 'a'.repeat(64), prev_hash: '9'.repeat(64), utc: 1770000000000, difficulty: 100, epoch: 0 },
    { beat_index: 15, hash: 'b'.repeat(64), prev_hash: 'e'.repeat(64), utc: 1770000300000, difficulty: 100, epoch: 0 },
  ];

  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      anchor: anchors[callCount++],
      on_chain: { tx_signature: null },
    }),
  });

  const client = createBeatsClient({ fetchImpl });
  await client.getAnchor(); // 10 OK

  // Jump to 15 — fails closed
  await assert.rejects(
    () => client.getAnchor(),
    { message: /jump/i },
  );
  assert.equal(client.isBroken(), true, 'Client should be broken after jump');

  // Stays broken until explicit resync
  await assert.rejects(() => client.getAnchor(), { message: /broken/i });
});

// ============ B-3: ANCHOR HASH RECOMPUTATION ============

test('B-3: verifyAnchorHash recomputes valid anchor hash', async () => {
  const prevHash = 'a'.repeat(64);
  const beatIndex = 5;
  const utc = 1770000000000;
  const epoch = 0;
  const difficulty = 10; // low for test speed

  const hash = computeAnchorHash(prevHash, beatIndex, utc, epoch, difficulty);

  const client = createBeatsClient({ fetchImpl: dummyFetch });
  const valid = await client.verifyAnchorHash({
    beat_index: beatIndex,
    hash,
    prev_hash: prevHash,
    utc,
    difficulty,
    epoch,
  });
  assert.equal(valid, true, 'Should verify correctly computed hash');
});

test('B-3: verifyAnchorHash rejects tampered hash', async () => {
  const client = createBeatsClient({ fetchImpl: dummyFetch });
  const valid = await client.verifyAnchorHash({
    beat_index: 5,
    hash: '0'.repeat(64), // wrong hash
    prev_hash: 'a'.repeat(64),
    utc: 1770000000000,
    difficulty: 10,
    epoch: 0,
  });
  assert.equal(valid, false, 'Should reject tampered hash');
});

test('B-3: verifyAnchorHash rejects invalid fields', async () => {
  const client = createBeatsClient({ fetchImpl: dummyFetch });
  assert.equal(await client.verifyAnchorHash(null), false, 'null anchor');
  assert.equal(await client.verifyAnchorHash({ beat_index: -1, hash: 'a'.repeat(64), prev_hash: 'b'.repeat(64), utc: 0, difficulty: 10, epoch: 0 }), false, 'negative beat_index');
  assert.equal(await client.verifyAnchorHash({ beat_index: 0, hash: 'short', prev_hash: 'b'.repeat(64), utc: 0, difficulty: 10, epoch: 0 }), false, 'invalid hash length');
});

test('B-3: getAnchor({ recompute: true }) verifies hash', async () => {
  const prevHash = 'a'.repeat(64);
  const beatIndex = 3;
  const utc = 1770000000000;
  const epoch = 0;
  const difficulty = 5;
  const hash = computeAnchorHash(prevHash, beatIndex, utc, epoch, difficulty);

  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      anchor: { beat_index: beatIndex, hash, prev_hash: prevHash, utc, difficulty, epoch },
      on_chain: { tx_signature: null },
    }),
  });

  const client = createBeatsClient({ fetchImpl });
  const result = await client.getAnchor({ recompute: true });
  assert.equal(result._verified_hash, true);
});

// ============ B-4: ON-CHAIN MEMO VERIFICATION ============

test('B-4: verifyOnChain with expectedPayload checks memo content', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (body.method === 'getSignatureStatuses') {
      return {
        ok: true,
        json: async () => ({
          result: { value: [{ confirmationStatus: 'finalized', slot: 123456 }] },
        }),
      };
    }
    if (body.method === 'getTransaction') {
      return {
        ok: true,
        json: async () => ({
          result: {
            transaction: {
              message: {
                instructions: [{
                  programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
                  parsed: JSON.stringify({
                    v: 1,
                    type: 'anchor',
                    beat_index: 42,
                    hash: 'c'.repeat(64),
                    prev: 'd'.repeat(64),
                    utc: 1770000000000,
                    difficulty: 1000,
                    epoch: 0,
                  }),
                }],
              },
            },
          },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const client = createBeatsClient({ fetchImpl });

  // Matching payload
  const result = await client.verifyOnChain('sig-ok', {
    cluster: 'devnet',
    expectedPayload: {
      hash: 'c'.repeat(64),
      beat_index: 42,
      prev_hash: 'd'.repeat(64),
    },
  });
  assert.equal(result.finalized, true);
  assert.equal(result.memoVerified, true, 'Memo should match expected payload');

  // Mismatched payload
  const bad = await client.verifyOnChain('sig-ok', {
    cluster: 'devnet',
    expectedPayload: {
      hash: '0'.repeat(64), // wrong
      beat_index: 42,
    },
  });
  assert.equal(bad.memoVerified, false, 'Memo should NOT match wrong payload');
});

test('B-4: verifyOnChain without expectedPayload works as before', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      result: { value: [{ confirmationStatus: 'finalized', slot: 999 }] },
    }),
  });

  const client = createBeatsClient({ fetchImpl });
  const result = await client.verifyOnChain('sig-simple', { cluster: 'devnet' });
  assert.equal(result.found, true);
  assert.equal(result.finalized, true);
  assert.equal(result.memoVerified, undefined, 'No memo check when no expectedPayload');
});

// ============ B-5: REQUEST TIMEOUT ============

test('B-5: request times out with AbortController', async () => {
  const fetchImpl = async (url, init) => {
    // Simulate slow response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve({ ok: true, text: async () => '{}' }), 5000);
      if (init?.signal) {
        init.signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
    });
  };

  const client = createBeatsClient({ fetchImpl, timeoutMs: 100 });
  await assert.rejects(
    () => client.getHealth(),
    { name: 'AbortError' },
    'Should abort after timeout'
  );
});
