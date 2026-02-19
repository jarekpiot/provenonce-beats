#!/usr/bin/env node
/**
 * E2E test: beats-client against live beats.provenonce.dev
 *
 * Exercises the full verification stack:
 *   1. Key fetch + pinning
 *   2. Anchor receipt verification (Ed25519)
 *   3. Anchor hash recomputation (SHA-256 chain)
 *   4. Chain continuity (beat_index+1, prev_hash linkage)
 *   5. Persistence across restart (onStateChange / loadState)
 *   6. Fail-closed on break + explicit resync
 *   7. On-chain memo verification (Solana devnet)
 *
 * Requires ~2 minutes (waits for anchor rotation).
 */

import { createBeatsClient } from '../sdk/beats-client/index.mjs';

const BEATS_URL = 'https://beats.provenonce.dev';
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[36mINFO\x1b[0m';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ${PASS}  ${label}${detail ? ' — ' + detail : ''}`);
    passed++;
  } else {
    console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function info(msg) {
  console.log(`  ${INFO}  ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('\n=== E2E: @provenonce/beats-client v0.3.0 vs live Beats service ===\n');

  // ── Step 1: Fetch signing key ──
  console.log('── Step 1: Key fetch + pinning ──');
  const unpinned = createBeatsClient({ baseUrl: BEATS_URL });
  const keyData = await unpinned.getKey();
  const pinnedKey = keyData.public_key_hex;
  check('Key fetched from /api/v1/beat/key', !!pinnedKey, `${pinnedKey.slice(0, 16)}...`);
  check('Algorithm is Ed25519', keyData.algorithm === 'Ed25519');

  // ── Step 2: Pinned client — fetch anchor + verify receipt ──
  console.log('\n── Step 2: Anchor fetch + receipt verification (pinned key) ──');
  let savedState = null;
  const onStateChange = (s) => { savedState = { ...s }; };

  const client = createBeatsClient({
    baseUrl: BEATS_URL,
    pinnedPublicKey: pinnedKey,
    onStateChange,
  });

  const resp1 = await client.getAnchor({ verify: true, recompute: true });
  const anchor1 = resp1.anchor;
  check('Anchor fetched', !!anchor1, `beat_index=${anchor1.beat_index}`);
  check('Receipt verified (Ed25519, pinned key)', resp1._verified_receipt === true);
  check('Hash recomputed (SHA-256 chain)', resp1._verified_hash === true);
  check('State persisted via onStateChange', savedState?.beat_index === anchor1.beat_index);
  info(`Anchor: idx=${anchor1.beat_index} hash=${anchor1.hash.slice(0, 16)}... diff=${anchor1.difficulty}`);

  // ── Step 3: Wrong key rejection ──
  console.log('\n── Step 3: Wrong key rejection ──');
  const wrongKeyClient = createBeatsClient({
    baseUrl: BEATS_URL,
    pinnedPublicKey: 'a'.repeat(64), // wrong key
  });
  const resp2 = await wrongKeyClient.getAnchor();
  const wrongKeyResult = await wrongKeyClient.verifyReceipt(resp2);
  check('Receipt rejected with wrong pinned key', wrongKeyResult === false);

  // ── Step 4: Wait for next anchor, verify continuity ──
  console.log('\n── Step 4: Chain continuity (waiting for next anchor...) ──');
  const anchorAge = Date.now() - anchor1.utc;
  const waitMs = Math.max(0, 62_000 - anchorAge); // anchors every ~60s
  if (waitMs > 0) {
    info(`Current anchor is ${Math.round(anchorAge / 1000)}s old, waiting ${Math.round(waitMs / 1000)}s for rotation...`);
    await sleep(waitMs);
  }

  // Poll until we get the next anchor (beat_index + 1)
  let anchor2 = null;
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await client.getAnchor({ verify: true, recompute: true });
      if (resp.anchor.beat_index > anchor1.beat_index) {
        anchor2 = resp.anchor;
        check('Next anchor fetched', true, `beat_index=${anchor2.beat_index}`);
        check('Consecutive beat_index', anchor2.beat_index === anchor1.beat_index + 1);
        check('prev_hash links to previous', anchor2.prev_hash === anchor1.hash);
        check('Receipt verified on new anchor', resp._verified_receipt === true);
        check('Hash recomputed on new anchor', resp._verified_hash === true);
        check('State updated', savedState?.beat_index === anchor2.beat_index);
        break;
      }
    } catch (e) {
      // Transient network/fetch errors — retry silently
      if (i % 5 === 4) info(`Retrying... (${e.message})`);
    }
    await sleep(5000);
  }
  if (!anchor2) {
    check('Next anchor fetched within timeout', false, 'Timed out after 150s');
  }

  // ── Step 5: Restart persistence ──
  console.log('\n── Step 5: Restart persistence (new client from saved state) ──');
  info(`Saved state: beat_index=${savedState.beat_index} hash=${savedState.hash.slice(0, 16)}...`);

  const client2 = createBeatsClient({
    baseUrl: BEATS_URL,
    pinnedPublicKey: pinnedKey,
    loadState: () => savedState,
    onStateChange,
  });

  // Fetching the same anchor should work (idempotent re-fetch)
  const lastAnchor = client2.getLastKnownAnchor();
  check('Restarted client loaded state', lastAnchor?.beat_index === savedState.beat_index);
  check('Hash matches saved state', lastAnchor?.hash === savedState.hash);

  // ── Step 6: Fail-closed on break + resync ──
  console.log('\n── Step 6: Fail-closed + resync ──');

  const brokenClient = createBeatsClient({
    baseUrl: BEATS_URL,
    pinnedPublicKey: pinnedKey,
  });
  // Seed with a fake anchor so the next real fetch triggers a jump
  brokenClient.setLastKnownAnchor({
    beat_index: 1,
    hash: 'f'.repeat(64),
    prev_hash: '0'.repeat(64),
    utc: 0,
    difficulty: 1,
    epoch: 0,
  });

  let jumpDetected = false;
  try {
    await brokenClient.getAnchor();
  } catch (e) {
    jumpDetected = e.code === 'ANCHOR_JUMP';
  }
  check('Beat index jump detected (fail-closed)', jumpDetected);
  check('Client reports broken', brokenClient.isBroken() === true);

  // Further calls fail
  let staysBroken = false;
  try {
    await brokenClient.getAnchor();
  } catch (e) {
    staysBroken = e.code === 'CHAIN_BROKEN';
  }
  check('Stays broken (no silent recovery)', staysBroken);

  // setLastKnownAnchor blocked while broken
  let seedBlocked = false;
  try {
    brokenClient.setLastKnownAnchor({ beat_index: 999, hash: 'a'.repeat(64) });
  } catch (e) {
    seedBlocked = /broken/i.test(e.message);
  }
  check('setLastKnownAnchor blocked while broken', seedBlocked);

  // Explicit resync
  const currentAnchor = anchor2 || anchor1;
  brokenClient.resync(currentAnchor);
  check('resync() clears broken state', brokenClient.isBroken() === false);
  check('resync() sets new baseline', brokenClient.getLastKnownAnchor()?.beat_index === currentAnchor.beat_index);

  // ── Step 7: On-chain verification ──
  console.log('\n── Step 7: On-chain verification (Solana devnet) ──');
  const txSig = resp1.on_chain?.tx_signature;
  if (txSig) {
    try {
      const onChainResult = await client.verifyOnChain(txSig, {
        cluster: 'devnet',
        expectedPayload: {
          hash: anchor1.hash,
          beat_index: anchor1.beat_index,
        },
      });
      check('Transaction found on Solana', onChainResult.found === true);
      check('Transaction finalized', onChainResult.finalized === true);
      if (onChainResult.memoVerified !== undefined) {
        check('Memo content matches anchor', onChainResult.memoVerified === true);
      } else {
        info('Memo verification skipped (getTransaction may not be available on public devnet RPC)');
      }
    } catch (e) {
      info(`On-chain check error (expected on public RPC): ${e.message}`);
    }
  } else {
    info('No tx_signature on this anchor — skipping on-chain check');
  }

  // ── Step 8: Timeout test ──
  console.log('\n── Step 8: Request timeout ──');
  // Use non-routable IP to guarantee timeout (no third-party dependency)
  const timeoutClient = createBeatsClient({
    baseUrl: 'http://10.255.255.1',
    timeoutMs: 2000,
  });
  let timedOut = false;
  const t0 = Date.now();
  try {
    await timeoutClient.getHealth();
  } catch (e) {
    timedOut = (Date.now() - t0) < 5000; // completed within 5s = timeout worked
  }
  check('Request aborted after timeout', timedOut);

  // ── Summary ──
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
