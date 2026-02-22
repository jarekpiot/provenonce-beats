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

## LocalBeatChain

Agent-side sequential SHA-256 hash chain. Computes beats locally — no network required. Use `getProof()` to generate a work proof and submit it to the Beats service.

Node.js only (uses `node:crypto`).

### Simple Agent

```js
import { LocalBeatChain, createBeatsClient } from '@provenonce/beats-client';

const chain = await LocalBeatChain.create({ seed: 'my-agent-id', difficulty: 1000 });
const beats = createBeatsClient();

// Compute beats continuously
setInterval(async () => {
  await chain.advance();
}, 10); // advance every 10ms

// Submit a work proof every minute
setInterval(async () => {
  const anchor = await beats.getAnchor();
  chain.setAnchorIndex(anchor.anchor.beat_index, anchor.anchor.hash);
  const proof = chain.getProof();
  const result = await beats.submitWorkProof(proof);
  if (result.valid) console.log('Work proof accepted:', result.receipt.beats_verified, 'beats');
}, 60_000);
```

### Auto-Advance

```js
const chain = await LocalBeatChain.create({ seed: 'my-agent', difficulty: 1000 });
chain.startAutoAdvance({
  intervalMs: 100,
  onAdvance: (beat, state) => console.log(`beat ${beat.index}: ${beat.hash.slice(0, 8)}...`),
  onError: (err) => console.error('advance failed:', err),
});
// Later:
chain.stopAutoAdvance();
```

### Persistent Agent (Survive Restarts)

```js
import { LocalBeatChain } from '@provenonce/beats-client';
import { readFileSync, writeFileSync } from 'fs';

// On startup: restore or create
let chain;
try {
  chain = await LocalBeatChain.restore(JSON.parse(readFileSync('chain.json', 'utf8')));
  console.log('Restored at beat', chain.beatCount);
} catch {
  chain = await LocalBeatChain.create({ seed: 'my-agent-id', difficulty: 1000 });
}

// Persist periodically
setInterval(() => {
  writeFileSync('chain.json', chain.persist());
  chain.clearHistory(200); // keep last 200 beats in memory
}, 30_000);
```

### Resync After Gap (D-72 Re-Sync Challenge)

```js
import { LocalBeatChain, BEATS_PER_ANCHOR, MAX_RESYNC_BEATS } from '@provenonce/beats-client';
const beats = createBeatsClient();

const chain = await LocalBeatChain.create({ seed: 'my-agent', difficulty: 1000, anchorIndex: 0 });

// On reconnect: detect and compute catch-up
const anchor = await beats.getAnchor();
const gap = chain.detectGap(anchor.anchor.beat_index);
if (gap.gap_beats_needed > 0) {
  console.log(`Gap of ${gap.gap_anchors} anchors — computing ${gap.gap_beats_needed} catch-up beats`);
  await chain.computeCatchup(anchor.anchor.beat_index, anchor.anchor.hash);
}
```

### API Reference

| Method | Description |
|--------|-------------|
| `LocalBeatChain.create(opts)` | Create a new chain from a seed string |
| `LocalBeatChain.restore(state)` | Restore from `JSON.parse(chain.persist())` |
| `chain.advance()` | Compute and append the next beat |
| `chain.getProof(lo?, hi?, spotCheckCount?)` | Build `WorkProofRequest` from history |
| `chain.detectGap(currentAnchorIndex)` | Returns `{ gap_anchors, gap_beats_needed, last_anchor_index }` |
| `chain.computeCatchup(anchorIndex, anchorHash?)` | Compute catch-up beats, returns count |
| `chain.setAnchorIndex(index, hash?)` | Update anchor without computing beats |
| `chain.clearHistory(keepLast?)` | Trim history to N most recent beats |
| `chain.persist()` | Serialize to JSON string (includes history) |
| `chain.getState()` | State snapshot (no history) |
| `chain.startAutoAdvance(opts)` | Start timer-based advancing |
| `chain.stopAutoAdvance()` | Stop timer |

**Constants:**
- `BEATS_PER_ANCHOR = 100` — Expected beats per anchor interval
- `MAX_RESYNC_BEATS = 10_000` — Cap on catch-up beats per resync

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

