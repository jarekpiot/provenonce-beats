import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createBeatsClient } from '../sdk/beats-client/index.mjs';

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
  return { pubHex, signature };
}

test('verifyReceipt validates signed timestamp payload', async () => {
  const payload = {
    hash: 'a'.repeat(64),
    anchor_index: 123,
    anchor_hash: 'b'.repeat(64),
    utc: 1770000000000,
    tx_signature: 'sig123',
  };
  const { pubHex, signature } = makeSignedResponse(payload);
  const client = createBeatsClient({ fetchImpl: async () => ({ ok: true, text: async () => '{}' }) });
  const ok = await client.verifyReceipt({
    timestamp: payload,
    receipt: { signature, public_key: pubHex },
  });
  assert.equal(ok, true);
});

test('getAnchor({ verify: true }) auto-verifies receipt', async () => {
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
  const client = createBeatsClient({ fetchImpl });
  const out = await client.getAnchor({ verify: true });
  assert.equal(out._verified_receipt, true);
});

test('verifyOnChain parses Solana status response', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      result: {
        value: [{ confirmationStatus: 'finalized', slot: 123456 }],
      },
    }),
  });
  const client = createBeatsClient({ fetchImpl });
  const result = await client.verifyOnChain('sig-on-chain', { cluster: 'devnet' });
  assert.equal(result.found, true);
  assert.equal(result.finalized, true);
  assert.equal(result.slot, 123456);
});

