/**
 * Phase 3 — LocalBeatChain Tests
 *
 * 25+ unit tests + 5 integration tests.
 * Uses difficulty 10 for speed. No network calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LocalBeatChain,
  computeBeat,
  createGenesisBeat,
  BEATS_PER_ANCHOR,
  MAX_RESYNC_BEATS,
} from '../sdk/beats-client/index.mjs';

const DIFFICULTY = 10; // low difficulty for test speed

// ── Helper: verify a single spot check locally ─────────────────────────────

function verifySpotCheck(sc, difficulty, anchorHash) {
  const seed = anchorHash
    ? `${sc.prev}:${sc.index}::${anchorHash}`
    : `${sc.prev}:${sc.index}:`;
  let h = createHash('sha256').update(seed, 'utf8').digest('hex');
  for (let i = 0; i < difficulty; i++) {
    h = createHash('sha256').update(h, 'utf8').digest('hex');
  }
  return h === sc.hash;
}

// ── Constants ────────────────────────────────────────────────────────────────

test('BEATS_PER_ANCHOR is 100', () => {
  assert.equal(BEATS_PER_ANCHOR, 100);
});

test('MAX_RESYNC_BEATS is 10000', () => {
  assert.equal(MAX_RESYNC_BEATS, 10_000);
});

// ── create() ─────────────────────────────────────────────────────────────────

test('create() produces a chain with genesis beat at index 0', async () => {
  const chain = await LocalBeatChain.create({ seed: 'test-agent', difficulty: DIFFICULTY });
  assert.equal(chain.genesis.index, 0);
  assert.equal(chain.head.index, 0);
  assert.equal(chain.beatCount, 0);
});

test('create() genesis hash is deterministic from seed', async () => {
  const a = await LocalBeatChain.create({ seed: 'deterministic-seed', difficulty: DIFFICULTY });
  const b = await LocalBeatChain.create({ seed: 'deterministic-seed', difficulty: DIFFICULTY });
  assert.equal(a.genesis.hash, b.genesis.hash);
});

test('create() different seeds produce different genesis hashes', async () => {
  const a = await LocalBeatChain.create({ seed: 'seed-A', difficulty: DIFFICULTY });
  const b = await LocalBeatChain.create({ seed: 'seed-B', difficulty: DIFFICULTY });
  assert.notEqual(a.genesis.hash, b.genesis.hash);
});

test('create() genesis.prev is 64 zeros', async () => {
  const chain = await LocalBeatChain.create({ seed: 'test', difficulty: DIFFICULTY });
  assert.equal(chain.genesis.prev, '0'.repeat(64));
});

test('create() genesis.hash matches createGenesisBeat()', async () => {
  const genesis = await createGenesisBeat('match-test', 'beats:genesis:v1:');
  const chain = await LocalBeatChain.create({ seed: 'match-test', difficulty: DIFFICULTY });
  assert.equal(chain.genesis.hash, genesis.hash);
});

test('create() throws if seed is empty', async () => {
  await assert.rejects(
    () => LocalBeatChain.create({ seed: '', difficulty: DIFFICULTY }),
    /seed must be a non-empty string/,
  );
});

test('create() initializes historyLength to 1 (genesis)', async () => {
  const chain = await LocalBeatChain.create({ seed: 'hist-test', difficulty: DIFFICULTY });
  assert.equal(chain.historyLength, 1);
});

// ── advance() ────────────────────────────────────────────────────────────────

test('advance() increments head.index by 1', async () => {
  const chain = await LocalBeatChain.create({ seed: 'adv-test', difficulty: DIFFICULTY });
  await chain.advance();
  assert.equal(chain.head.index, 1);
  await chain.advance();
  assert.equal(chain.head.index, 2);
});

test('advance() sets head.prev to previous head.hash', async () => {
  const chain = await LocalBeatChain.create({ seed: 'adv-prev', difficulty: DIFFICULTY });
  const genHash = chain.genesis.hash;
  await chain.advance();
  assert.equal(chain.head.prev, genHash);
  const h1 = chain.head.hash;
  await chain.advance();
  assert.equal(chain.head.prev, h1);
});

test('advance() increments beatCount', async () => {
  const chain = await LocalBeatChain.create({ seed: 'adv-count', difficulty: DIFFICULTY });
  assert.equal(chain.beatCount, 0);
  await chain.advance();
  assert.equal(chain.beatCount, 1);
  await chain.advance();
  assert.equal(chain.beatCount, 2);
});

test('advance() increments historyLength', async () => {
  const chain = await LocalBeatChain.create({ seed: 'adv-hist', difficulty: DIFFICULTY });
  assert.equal(chain.historyLength, 1);
  await chain.advance();
  assert.equal(chain.historyLength, 2);
  await chain.advance();
  assert.equal(chain.historyLength, 3);
});

test('advance() returns beat object with correct shape', async () => {
  const chain = await LocalBeatChain.create({ seed: 'adv-shape', difficulty: DIFFICULTY });
  const beat = await chain.advance();
  assert.equal(typeof beat.index, 'number');
  assert.equal(typeof beat.hash, 'string');
  assert.equal(beat.hash.length, 64);
  assert.equal(typeof beat.prev, 'string');
  assert.equal(beat.prev.length, 64);
});

test('advance() with anchor hash weaves it into beats', async () => {
  const anchorHash = 'a'.repeat(64);
  const chain = await LocalBeatChain.create({ seed: 'adv-anchor', difficulty: DIFFICULTY, anchorHash });
  await chain.advance();
  assert.equal(chain.head.anchor_hash, anchorHash);
});

test('advance() trims history to maxHistory', async () => {
  const chain = await LocalBeatChain.create({ seed: 'adv-trim', difficulty: DIFFICULTY, maxHistory: 5 });
  for (let i = 0; i < 10; i++) await chain.advance();
  assert.ok(chain.historyLength <= 5, `historyLength should be <= 5, got ${chain.historyLength}`);
});

// ── getProof() ───────────────────────────────────────────────────────────────

test('getProof() throws if no work beats have been computed', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-nowork', difficulty: DIFFICULTY });
  assert.throws(
    () => chain.getProof(),
    /no work beats in history/,
  );
});

test('getProof() returns object with required WorkProofRequest fields', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-fields', difficulty: DIFFICULTY });
  for (let i = 0; i < 5; i++) await chain.advance();
  const proof = chain.getProof();
  assert.equal(typeof proof.from_hash, 'string');
  assert.equal(proof.from_hash.length, 64);
  assert.equal(typeof proof.to_hash, 'string');
  assert.equal(proof.to_hash.length, 64);
  assert.equal(typeof proof.beats_computed, 'number');
  assert.ok(proof.beats_computed > 0);
  assert.equal(typeof proof.difficulty, 'number');
  assert.equal(typeof proof.anchor_index, 'number');
  assert.ok(Array.isArray(proof.spot_checks));
  assert.ok(proof.spot_checks.length > 0);
});

test('getProof() from_hash is prev of first work beat', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-fromhash', difficulty: DIFFICULTY });
  await chain.advance(); // beat index 1
  await chain.advance();
  const proof = chain.getProof();
  // first work beat is at index 1; its prev is the genesis hash
  assert.equal(proof.from_hash, chain.genesis.hash);
});

test('getProof() to_hash matches current head hash', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-tohash', difficulty: DIFFICULTY });
  for (let i = 0; i < 5; i++) await chain.advance();
  const proof = chain.getProof();
  assert.equal(proof.to_hash, chain.head.hash);
});

test('getProof() beats_computed matches window span', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-beats', difficulty: DIFFICULTY });
  for (let i = 0; i < 5; i++) await chain.advance();
  const proof = chain.getProof();
  // 5 work beats at indices 1..5: beats_computed = 5 - 1 + 1 = 5
  assert.equal(proof.beats_computed, 5);
});

test('getProof() spot_checks count respects spotCheckCount param', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-spotcount', difficulty: DIFFICULTY });
  for (let i = 0; i < 10; i++) await chain.advance();
  const proof3 = chain.getProof(undefined, undefined, 3);
  assert.equal(proof3.spot_checks.length, 3);
  const proof7 = chain.getProof(undefined, undefined, 7);
  assert.equal(proof7.spot_checks.length, 7);
});

test('getProof() spot_checks have index, hash, prev fields', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-sc-fields', difficulty: DIFFICULTY });
  for (let i = 0; i < 5; i++) await chain.advance();
  const proof = chain.getProof();
  for (const sc of proof.spot_checks) {
    assert.equal(typeof sc.index, 'number');
    assert.equal(typeof sc.hash, 'string');
    assert.equal(sc.hash.length, 64);
    assert.equal(typeof sc.prev, 'string');
    assert.equal(sc.prev.length, 64);
    assert.equal(sc.signature, undefined, 'spot_checks must not include signature field');
  }
});

test('getProof() with lo/hi filters to beat index range', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-lohi', difficulty: DIFFICULTY });
  for (let i = 0; i < 10; i++) await chain.advance();
  const proof = chain.getProof(3, 7);
  for (const sc of proof.spot_checks) {
    assert.ok(sc.index >= 3, `index ${sc.index} < lo=3`);
    assert.ok(sc.index <= 7, `index ${sc.index} > hi=7`);
  }
});

test('getProof() does not include anchor_hash when none set', async () => {
  const chain = await LocalBeatChain.create({ seed: 'proof-noanchor', difficulty: DIFFICULTY });
  await chain.advance();
  const proof = chain.getProof();
  assert.equal(proof.anchor_hash, undefined);
});

test('getProof() includes anchor_hash when set', async () => {
  const ah = 'b'.repeat(64);
  const chain = await LocalBeatChain.create({ seed: 'proof-withanchor', difficulty: DIFFICULTY, anchorHash: ah });
  await chain.advance();
  const proof = chain.getProof();
  assert.equal(proof.anchor_hash, ah);
});

// ── detectGap() ───────────────────────────────────────────────────────────────

test('detectGap() returns 0 when no gap', async () => {
  const chain = await LocalBeatChain.create({ seed: 'gap-zero', difficulty: DIFFICULTY, anchorIndex: 100 });
  const gap = chain.detectGap(100);
  assert.equal(gap.gap_anchors, 0);
  assert.equal(gap.gap_beats_needed, 0);
  assert.equal(gap.last_anchor_index, 100);
});

test('detectGap() returns correct gap_anchors', async () => {
  const chain = await LocalBeatChain.create({ seed: 'gap-anchors', difficulty: DIFFICULTY, anchorIndex: 50 });
  const gap = chain.detectGap(55);
  assert.equal(gap.gap_anchors, 5);
  assert.equal(gap.gap_beats_needed, 5 * BEATS_PER_ANCHOR);
  assert.equal(gap.last_anchor_index, 50);
});

test('detectGap() caps gap_beats_needed at MAX_RESYNC_BEATS', async () => {
  const chain = await LocalBeatChain.create({ seed: 'gap-cap', difficulty: DIFFICULTY, anchorIndex: 0 });
  // gap_anchors = 200, BEATS_PER_ANCHOR = 100 → 20000 uncapped → capped at 10000
  const gap = chain.detectGap(200);
  assert.equal(gap.gap_anchors, 200);
  assert.equal(gap.gap_beats_needed, MAX_RESYNC_BEATS);
});

test('detectGap() returns 0 if currentAnchorIndex < chain anchor', async () => {
  const chain = await LocalBeatChain.create({ seed: 'gap-neg', difficulty: DIFFICULTY, anchorIndex: 100 });
  const gap = chain.detectGap(90);
  assert.equal(gap.gap_anchors, 0);
  assert.equal(gap.gap_beats_needed, 0);
});

// ── computeCatchup() ─────────────────────────────────────────────────────────

test('computeCatchup() returns 0 when no gap', async () => {
  const chain = await LocalBeatChain.create({ seed: 'catchup-zero', difficulty: DIFFICULTY, anchorIndex: 5 });
  const count = await chain.computeCatchup(5);
  assert.equal(count, 0);
});

test('computeCatchup() advances chain by gap_beats_needed', async () => {
  const chain = await LocalBeatChain.create({ seed: 'catchup-beats', difficulty: DIFFICULTY, anchorIndex: 0 });
  // gap of 1 anchor = 100 beats
  const initialCount = chain.beatCount;
  const computed = await chain.computeCatchup(1);
  assert.equal(computed, BEATS_PER_ANCHOR);
  assert.equal(chain.beatCount, initialCount + BEATS_PER_ANCHOR);
}, { timeout: 30_000 });

test('computeCatchup() updates anchorIndex', async () => {
  const chain = await LocalBeatChain.create({ seed: 'catchup-idx', difficulty: DIFFICULTY, anchorIndex: 0 });
  await chain.computeCatchup(2);
  assert.equal(chain.anchorIndex, 2);
}, { timeout: 30_000 });

test('computeCatchup() updates anchorHash', async () => {
  const chain = await LocalBeatChain.create({ seed: 'catchup-hash', difficulty: DIFFICULTY, anchorIndex: 0 });
  const newAnchorHash = 'c'.repeat(64);
  await chain.computeCatchup(1, newAnchorHash);
  assert.equal(chain.anchorHash, newAnchorHash);
}, { timeout: 30_000 });

// ── setAnchorIndex() ──────────────────────────────────────────────────────────

test('setAnchorIndex() updates anchorIndex and anchorHash', async () => {
  const chain = await LocalBeatChain.create({ seed: 'setanchor', difficulty: DIFFICULTY });
  chain.setAnchorIndex(42, 'd'.repeat(64));
  assert.equal(chain.anchorIndex, 42);
  assert.equal(chain.anchorHash, 'd'.repeat(64));
});

test('setAnchorIndex() null anchorHash clears it', async () => {
  const chain = await LocalBeatChain.create({ seed: 'setanchor-null', difficulty: DIFFICULTY, anchorHash: 'e'.repeat(64) });
  chain.setAnchorIndex(10, null);
  assert.equal(chain.anchorHash, null);
});

test('setAnchorIndex() throws on invalid anchorIndex', async () => {
  const chain = await LocalBeatChain.create({ seed: 'setanchor-err', difficulty: DIFFICULTY });
  assert.throws(() => chain.setAnchorIndex(-1), /non-negative integer/);
  assert.throws(() => chain.setAnchorIndex(1.5), /non-negative integer/);
  assert.throws(() => chain.setAnchorIndex('abc'), /non-negative integer/);
});

// ── clearHistory() ───────────────────────────────────────────────────────────

test('clearHistory() trims history to keepLast', async () => {
  const chain = await LocalBeatChain.create({ seed: 'clear-hist', difficulty: DIFFICULTY });
  for (let i = 0; i < 20; i++) await chain.advance();
  assert.equal(chain.historyLength, 21); // genesis + 20 beats
  chain.clearHistory(5);
  assert.equal(chain.historyLength, 5);
});

test('clearHistory() does not change beatCount', async () => {
  const chain = await LocalBeatChain.create({ seed: 'clear-count', difficulty: DIFFICULTY });
  for (let i = 0; i < 10; i++) await chain.advance();
  const countBefore = chain.beatCount;
  chain.clearHistory(3);
  assert.equal(chain.beatCount, countBefore);
});

test('clearHistory() head hash is still accessible via head getter', async () => {
  const chain = await LocalBeatChain.create({ seed: 'clear-head', difficulty: DIFFICULTY });
  for (let i = 0; i < 10; i++) await chain.advance();
  const headHash = chain.head.hash;
  chain.clearHistory(3);
  assert.equal(chain.head.hash, headHash);
});

// ── getState() / persist() / restore() ───────────────────────────────────────

test('getState() returns all required fields', async () => {
  const chain = await LocalBeatChain.create({ seed: 'state-fields', difficulty: DIFFICULTY });
  await chain.advance();
  const state = chain.getState();
  assert.equal(typeof state.seed, 'string');
  assert.equal(typeof state.difficulty, 'number');
  assert.equal(typeof state.domainPrefix, 'string');
  assert.ok(state.genesis);
  assert.ok(state.head);
  assert.equal(typeof state.beatCount, 'number');
  assert.equal(typeof state.anchorIndex, 'number');
  assert.equal(typeof state.maxHistory, 'number');
  assert.equal(typeof state.lastUpdated, 'number');
});

test('persist() returns valid JSON string', async () => {
  const chain = await LocalBeatChain.create({ seed: 'persist-json', difficulty: DIFFICULTY });
  await chain.advance();
  const json = chain.persist();
  assert.equal(typeof json, 'string');
  const parsed = JSON.parse(json);
  assert.ok(parsed.seed);
  assert.ok(Array.isArray(parsed.history));
});

test('persist() includes history array', async () => {
  const chain = await LocalBeatChain.create({ seed: 'persist-hist', difficulty: DIFFICULTY });
  for (let i = 0; i < 5; i++) await chain.advance();
  const parsed = JSON.parse(chain.persist());
  assert.equal(parsed.history.length, chain.historyLength);
});

test('restore() recreates chain with matching head hash', async () => {
  const chain = await LocalBeatChain.create({ seed: 'restore-head', difficulty: DIFFICULTY });
  for (let i = 0; i < 5; i++) await chain.advance();
  const headHash = chain.head.hash;
  const restored = await LocalBeatChain.restore(JSON.parse(chain.persist()));
  assert.equal(restored.head.hash, headHash);
});

test('restore() restores beatCount', async () => {
  const chain = await LocalBeatChain.create({ seed: 'restore-count', difficulty: DIFFICULTY });
  for (let i = 0; i < 7; i++) await chain.advance();
  const restored = await LocalBeatChain.restore(JSON.parse(chain.persist()));
  assert.equal(restored.beatCount, 7);
});

test('restore() restores anchorIndex and anchorHash', async () => {
  const ah = 'f'.repeat(64);
  const chain = await LocalBeatChain.create({ seed: 'restore-anchor', difficulty: DIFFICULTY, anchorIndex: 42, anchorHash: ah });
  await chain.advance();
  const restored = await LocalBeatChain.restore(JSON.parse(chain.persist()));
  assert.equal(restored.anchorIndex, 42);
  assert.equal(restored.anchorHash, ah);
});

test('restore() throws on invalid state', async () => {
  await assert.rejects(
    () => LocalBeatChain.restore(null),
    /invalid state/,
  );
  await assert.rejects(
    () => LocalBeatChain.restore({ seed: 'no-head' }),
    /invalid state/,
  );
});

// ── startAutoAdvance() / stopAutoAdvance() ────────────────────────────────────

test('startAutoAdvance() calls onAdvance callback', async () => {
  const chain = await LocalBeatChain.create({ seed: 'auto-cb', difficulty: DIFFICULTY });
  await new Promise((resolve) => {
    chain.startAutoAdvance({
      intervalMs: 10,
      onAdvance: (beat, state) => {
        chain.stopAutoAdvance();
        assert.equal(typeof beat.hash, 'string');
        assert.equal(beat.hash.length, 64);
        assert.ok(state.beatCount >= 1);
        resolve();
      },
    });
  });
});

test('stopAutoAdvance() stops further advances', async () => {
  const chain = await LocalBeatChain.create({ seed: 'auto-stop', difficulty: DIFFICULTY });
  let count = 0;
  chain.startAutoAdvance({
    intervalMs: 10,
    onAdvance: () => { count++; },
  });
  await new Promise(r => setTimeout(r, 50));
  chain.stopAutoAdvance();
  const countAtStop = count;
  await new Promise(r => setTimeout(r, 50));
  // No more advances after stop
  assert.equal(count, countAtStop);
});

// ── Integration tests ─────────────────────────────────────────────────────────

test('[integration] full chain: create → advance → getProof → spot checks verify locally', async () => {
  const chain = await LocalBeatChain.create({ seed: 'integ-full', difficulty: DIFFICULTY });
  for (let i = 0; i < 10; i++) await chain.advance();
  const proof = chain.getProof(undefined, undefined, 5);

  // Verify each spot check locally
  for (const sc of proof.spot_checks) {
    const valid = verifySpotCheck(sc, DIFFICULTY, undefined);
    assert.ok(valid, `spot check at index ${sc.index} failed local verification`);
  }
});

test('[integration] anchor weaving: spot checks verify with anchor hash', async () => {
  const anchorHash = '1234'.repeat(16); // 64 hex chars
  const chain = await LocalBeatChain.create({ seed: 'integ-anchor', difficulty: DIFFICULTY, anchorHash });
  for (let i = 0; i < 5; i++) await chain.advance();
  const proof = chain.getProof();
  assert.equal(proof.anchor_hash, anchorHash);

  for (const sc of proof.spot_checks) {
    const valid = verifySpotCheck(sc, DIFFICULTY, anchorHash);
    assert.ok(valid, `spot-check at index ${sc.index} failed with anchor weaving`);
  }
});

test('[integration] persist/restore round-trip: getProof() still works', async () => {
  const chain = await LocalBeatChain.create({ seed: 'integ-restore', difficulty: DIFFICULTY });
  for (let i = 0; i < 8; i++) await chain.advance();
  const beforeProof = chain.getProof();

  const restored = await LocalBeatChain.restore(JSON.parse(chain.persist()));
  const afterProof = restored.getProof();

  assert.equal(afterProof.to_hash, beforeProof.to_hash);
  assert.equal(afterProof.beats_computed, beforeProof.beats_computed);
  assert.ok(afterProof.spot_checks.length > 0);

  for (const sc of afterProof.spot_checks) {
    const valid = verifySpotCheck(sc, DIFFICULTY, undefined);
    assert.ok(valid, `restored spot check at index ${sc.index} failed verification`);
  }
});

test('[integration] computeCatchup then getProof produces verifiable proof', async () => {
  const anchorHash = 'ab'.repeat(32);
  const chain = await LocalBeatChain.create({ seed: 'integ-catchup', difficulty: DIFFICULTY, anchorIndex: 0 });
  // Catchup 1 anchor gap (100 beats)
  const count = await chain.computeCatchup(1, anchorHash);
  assert.equal(count, BEATS_PER_ANCHOR);

  const proof = chain.getProof(undefined, undefined, 5);
  assert.equal(proof.anchor_hash, anchorHash);
  assert.equal(proof.anchor_index, 1);

  for (const sc of proof.spot_checks) {
    const valid = verifySpotCheck(sc, DIFFICULTY, anchorHash);
    assert.ok(valid, `catchup spot check at index ${sc.index} failed verification`);
  }
}, { timeout: 60_000 });

test('[integration] clearHistory + getProof still returns valid proof', async () => {
  const chain = await LocalBeatChain.create({ seed: 'integ-clear', difficulty: DIFFICULTY });
  for (let i = 0; i < 20; i++) await chain.advance();
  chain.clearHistory(5); // keep only last 5 beats

  const proof = chain.getProof();
  assert.ok(proof.beats_computed > 0);
  assert.equal(proof.to_hash, chain.head.hash);

  for (const sc of proof.spot_checks) {
    const valid = verifySpotCheck(sc, DIFFICULTY, undefined);
    assert.ok(valid, `post-clear spot check at index ${sc.index} failed verification`);
  }
});
