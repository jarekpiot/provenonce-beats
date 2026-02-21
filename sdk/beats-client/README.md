# @provenonce/beats-client

Minimal client for the public Beats service.

## Install

From npm (after publish):

```bash
npm i @provenonce/beats-client
```

Local repo path (pre-publish):

```bash
npm i ./sdk/beats-client
```

## Usage

```js
import { createBeatsClient } from '@provenonce/beats-client';

const beats = createBeatsClient();

const anchor = await beats.getAnchor();
const receipt = await beats.timestampHash('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const receiptValid = await beats.verifyReceipt(receipt);
const anchorValid = await beats.verifyAnchor(anchor);
const onChain = await beats.verifyOnChain(receipt.on_chain.tx_signature, { cluster: 'devnet' });

// Auto-verify anchor receipt:
const verifiedAnchor = await beats.getAnchor({ verify: true });
```

## Endpoints wrapped

- `GET /api/health`
- `GET /api/v1/beat/anchor`
- `GET /api/v1/beat/key`
- `POST /api/v1/beat/verify`
- `POST /api/v1/beat/timestamp`
- `POST /api/v1/beat/work-proof`

## Helpers

- `verifyReceipt(response)` - offline Ed25519 verification of timestamp/anchor receipts.
- `verifyAnchor(anchorResponse)` - explicit offline verification helper for anchor responses.
- `verifyOnChain(txSignature, { cluster | rpcUrl })` - direct Solana RPC status check.
- `getAnchor({ verify: true })` - fetch anchor and verify attached receipt in one call.
- `submitWorkProof(proof)` - submit work proof, receive signed receipt.
- `verifyWorkProofReceipt(response)` - offline Ed25519 verification of work-proof receipts.

## Work Proof

Submit a proof that N SHA-256 beats were computed at difficulty D, anchored to a recent
global beat. The Beats service verifies spot-checks and returns a signed receipt.

```js
import { computeBeat, createGenesisBeat, createBeatsClient } from '@provenonce/beats-client';

const genesis = await createGenesisBeat('my-agent-hash');
let prev = genesis;
const spotChecks = [];
for (let i = 0; i < 1000; i++) {
  prev = await computeBeat(prev.hash, prev.index + 1, 1000);
  if (i % 333 === 0) spotChecks.push({ index: prev.index, hash: prev.hash, prev: prev.prev });
}

const beats = createBeatsClient();
const anchor = await beats.getAnchor();

const result = await beats.submitWorkProof({
  from_hash: genesis.hash,
  to_hash: prev.hash,
  beats_computed: 1000,
  difficulty: 1000,
  anchor_index: anchor.anchor.beat_index,
  anchor_hash: anchor.anchor.hash,
  spot_checks: spotChecks,
});

if (result.valid) {
  const verified = await beats.verifyWorkProofReceipt(result);
  console.log('Receipt verified offline:', verified);
  console.log('Receipt:', result.receipt);
}
```

## Receipt Verification (Offline)

Beats issues signed receipts for timestamps and work proofs. Each receipt type uses a
different HKDF-derived key so signatures cannot be confused across types.

### Key Hierarchy

```
BEATS_ANCHOR_KEYPAIR (Ed25519 seed)
├── [HKDF "provenonce:beats:timestamp-receipt:v1"] → Timestamp signing key
└── [HKDF "provenonce:beats:work-proof:v1"]        → Work-proof signing key

GET /api/v1/beat/key returns both public keys:
{
  "keys": {
    "timestamp": { "public_key_hex": "...", "signing_context": "provenonce:beats:timestamp-receipt:v1" },
    "work_proof": { "public_key_hex": "...", "signing_context": "provenonce:beats:work-proof:v1" }
  }
}
```

### Offline Verification (Third-Party)

Third-party consumers can verify receipts without calling the Beats service:

1. Fetch the public key once: `GET /api/v1/beat/key`
2. Pin `keys.work_proof.public_key_hex` for work-proof receipts
3. Extract `{ signature, ...payload }` from the receipt
4. Verify: `Ed25519.verify(canonicalJSON(payload), base64decode(signature), publicKey)`

`canonicalJSON` means: sort keys alphabetically, then `JSON.stringify()`.

```js
// Manual verification without beats-client
import { createPublicKey, verify } from 'node:crypto';

const { signature, ...payload } = receipt;
const sortedPayload = Object.fromEntries(Object.entries(payload).sort());
const message = Buffer.from(JSON.stringify(sortedPayload), 'utf8');
const sig = Buffer.from(signature, 'base64');

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const pubKeyBytes = Buffer.from(publicKeyHex, 'hex');
const pubKeyDer = Buffer.concat([spkiPrefix, pubKeyBytes]);
const pubKey = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });

const valid = verify(null, message, pubKey, sig);
```

