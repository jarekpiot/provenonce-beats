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

## Helpers

- `verifyReceipt(response)` — offline Ed25519 verification of timestamp/anchor receipts.
- `verifyOnChain(txSignature, { cluster | rpcUrl })` — direct Solana RPC status check.
- `getAnchor({ verify: true })` — fetch anchor and verify attached receipt in one call.
