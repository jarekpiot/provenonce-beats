import test from 'node:test';
import assert from 'node:assert/strict';

import {
  genesisPrevHash,
  parseAnchorMemo,
  isContinuousNextAnchor,
  selectCanonicalAnchor,
} from '../lib/anchor-canonical.js';

function mk(idx, hash, prev, extra = {}) {
  return {
    beat_index: idx,
    hash,
    prev_hash: prev,
    utc: 1700000000000 + idx,
    difficulty: 1000,
    epoch: 0,
    ...extra,
  };
}

test('continuous chain: canonical tip must link through previous hashes', () => {
  const gprev = genesisPrevHash();
  const a0 = mk(0, 'a'.repeat(64), gprev);
  const a1 = mk(1, 'b'.repeat(64), a0.hash);
  const a2 = mk(2, 'c'.repeat(64), a1.hash);
  const best = selectCanonicalAnchor([a2, a1, a0]);
  assert.equal(best?.hash, a2.hash);
});

test('reject jump beat_index without valid linkage', () => {
  const latest = mk(10, 'a'.repeat(64), 'b'.repeat(64));
  const jump = mk(12, 'c'.repeat(64), latest.hash);
  assert.equal(isContinuousNextAnchor(latest, jump), false);
});

test('fork choice is deterministic and not just max beat_index in window', () => {
  const gprev = genesisPrevHash();
  const a0 = mk(0, 'a'.repeat(64), gprev);
  const a1 = mk(1, 'b'.repeat(64), a0.hash);
  const a2 = mk(2, 'c'.repeat(64), a1.hash);

  const unlinkedHigh = mk(3, 'f'.repeat(64), '9'.repeat(64));
  const best = selectCanonicalAnchor([unlinkedHigh, a2, a1, a0]);
  assert.equal(best?.hash, a2.hash);
});

test('duplicate memo / duplicate beat_index replay is rejected for continuity advance', () => {
  const latest = mk(5, 'a'.repeat(64), 'b'.repeat(64));
  const replaySame = mk(5, latest.hash, latest.prev_hash);
  const conflictSameIndex = mk(5, 'c'.repeat(64), latest.prev_hash);

  assert.equal(isContinuousNextAnchor(latest, replaySame), false);
  assert.equal(isContinuousNextAnchor(latest, conflictSameIndex), false);
});

test('anchor import verifies continuity before canonical head update', () => {
  const latest = mk(7, 'a'.repeat(64), 'b'.repeat(64));
  const wrongPrev = mk(8, 'c'.repeat(64), 'd'.repeat(64));
  const rightPrev = mk(8, 'e'.repeat(64), latest.hash);

  assert.equal(isContinuousNextAnchor(latest, wrongPrev), false);
  assert.equal(isContinuousNextAnchor(latest, rightPrev), true);
});

test('memo parser accepts valid anchor memo and rejects invalid payloads', () => {
  const valid = JSON.stringify({
    v: 1,
    type: 'anchor',
    beat_index: 1,
    hash: 'a'.repeat(64),
    prev: 'b'.repeat(64),
    utc: 1700000000000,
    difficulty: 1000,
    epoch: 0,
  });

  const parsed = parseAnchorMemo(`[123] ${valid}`);
  assert.equal(parsed?.beat_index, 1);

  const bad = JSON.stringify({
    v: 1,
    type: 'anchor',
    beat_index: 1,
    hash: 'short',
    prev: 'b'.repeat(64),
    utc: 1700000000000,
    difficulty: 1000,
    epoch: 0,
  });

  assert.equal(parseAnchorMemo(bad), null);
});
