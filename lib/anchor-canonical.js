import { createHash } from 'crypto';

const HEX64 = /^[0-9a-f]{64}$/i;

export function genesisPrevHash() {
  return createHash('sha256').update('provenonce:beat:genesis:v1:2026').digest('hex');
}

export function parseAnchorMemo(memo) {
  if (typeof memo !== 'string' || memo.length === 0) return null;

  let memoStr = memo;
  const bracketEnd = memoStr.indexOf('] ');
  if (bracketEnd !== -1 && memoStr.startsWith('[')) {
    memoStr = memoStr.slice(bracketEnd + 2);
  }

  let parsed;
  try {
    parsed = JSON.parse(memoStr);
  } catch {
    return null;
  }

  if (!parsed || parsed.v !== 1 || parsed.type !== 'anchor') return null;
  if (!Number.isInteger(parsed.beat_index) || parsed.beat_index < 0) return null;
  if (!HEX64.test(parsed.hash) || !HEX64.test(parsed.prev)) return null;
  if (!Number.isInteger(parsed.utc) || parsed.utc < 0) return null;
  if (!Number.isInteger(parsed.difficulty) || parsed.difficulty <= 0) return null;
  if (!Number.isInteger(parsed.epoch) || parsed.epoch < 0) return null;

  return {
    beat_index: parsed.beat_index,
    hash: parsed.hash,
    prev_hash: parsed.prev,
    utc: parsed.utc,
    difficulty: parsed.difficulty,
    epoch: parsed.epoch,
  };
}

export function isContinuousNextAnchor(latest, incoming) {
  if (!incoming || !Number.isInteger(incoming.beat_index) || !HEX64.test(incoming.hash) || !HEX64.test(incoming.prev_hash)) {
    return false;
  }
  if (!latest) {
    return incoming.beat_index === 0 && incoming.prev_hash === genesisPrevHash();
  }
  return incoming.beat_index === latest.beat_index + 1 && incoming.prev_hash === latest.hash;
}

export function selectCanonicalAnchor(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const deduped = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || !Number.isInteger(c.beat_index) || !HEX64.test(c.hash) || !HEX64.test(c.prev_hash)) continue;
    const key = `${c.beat_index}|${c.hash}|${c.prev_hash}|${c.utc}|${c.difficulty}|${c.epoch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  if (deduped.length === 0) return null;

  const byIndex = new Map();
  for (const c of deduped) {
    if (!byIndex.has(c.beat_index)) byIndex.set(c.beat_index, new Map());
    byIndex.get(c.beat_index).set(c.hash, c);
  }

  const scored = deduped.map((tip) => {
    let depth = 1;
    let current = tip;
    while (current.beat_index > 0) {
      const prevs = byIndex.get(current.beat_index - 1);
      if (!prevs) break;
      const prev = prevs.get(current.prev_hash);
      if (!prev) break;
      depth++;
      current = prev;
    }
    const linked = tip.beat_index === 0
      ? tip.prev_hash === genesisPrevHash()
      : depth > 1;
    return { tip, depth, linked };
  });

  const linkedOnly = scored.filter(s => s.linked);
  const pool = linkedOnly.length > 0 ? linkedOnly : scored;

  pool.sort((a, b) => {
    if (b.tip.beat_index !== a.tip.beat_index) return b.tip.beat_index - a.tip.beat_index;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.tip.hash.localeCompare(b.tip.hash);
  });

  return pool[0]?.tip || null;
}
