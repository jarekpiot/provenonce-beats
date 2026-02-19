import { createHash } from 'crypto';

// ============================================================
// PROVENONCE BEAT SERVICE
// Sequential-work hash chain engine for Provenonce
//
// "NTP tells you what time it is.
//  Provenonce tells you when the agent last proved it existed."
// ============================================================

// ============ TYPES ============

/** A single Beat — one tick of the sequential hash chain */
export interface Beat {
  index: number;            // Beat number (monotonically increasing)
  hash: string;             // SHA-256 output of this beat
  prev: string;             // Previous beat's hash (chain link)
  timestamp: number;        // Wall-clock time when computed (informational, not authoritative)
  nonce?: string;           // Optional entropy (for global anchors)
  anchor_hash?: string;     // Global anchor hash woven into beat seed (anti-pre-computation)
}

/** Global Beat Anchor — published by the Beats service */
export interface GlobalAnchor {
  beat_index: number;       // Which global beat this is
  hash: string;             // The anchor hash
  prev_hash: string;        // Previous anchor hash
  utc: number;              // UTC timestamp for temporal reference
  difficulty: number;       // Current difficulty (hash iterations per beat)
  epoch: number;            // Epoch number (difficulty adjustment period)
  solana_entropy?: string;  // A-4: Finalized Solana blockhash (base58) injected as external entropy
  signature?: string;       // Solana tx signature of anchor broadcast
}

/**
 * V3 binary-canonical domain prefix for anchor hash computation.
 * UTF-8 encoded as the first 19 bytes of the preimage.
 */
export const ANCHOR_DOMAIN_PREFIX = 'PROVENONCE_BEATS_V1';

/** Local Beat Chain — maintained by each agent */
export interface LocalBeatChain {
  agent_hash: string;       // Which agent owns this chain
  genesis: string;          // First beat hash (derived from agent registration)
  latest: Beat;             // Most recent beat
  total_beats: number;      // Total beats computed
  last_checkin: number;     // Beat index of last registry check-in
  last_global_sync: number; // Global beat index at last sync
  status: 'active' | 'frozen' | 'revoked' | 'gestating';
}

/** Check-in proof submitted to the registry */
export interface BeatProof {
  agent_hash: string;
  from_beat: number;        // Starting beat index of proof window
  to_beat: number;          // Ending beat index
  from_hash: string;        // Hash at from_beat
  to_hash: string;          // Hash at to_beat
  beats_computed: number;   // Number of beats in this window
  global_anchor: number;    // Global beat index being synced to
  anchor_hash?: string;     // Global anchor hash used for all beats in this window
  // Spot-check: registry can verify any beat in the chain
  // prev is required for hash-chain recomputation verification
  spot_checks?: { index: number; hash: string; prev: string; nonce?: string }[];
}

/** Temporal Gestation requirement for spawning */
export interface GestationRequirement {
  parent_hash: string;
  required_beats: number;   // Beats parent must accumulate before spawning
  accumulated_beats: number;
  met: boolean;
  spawn_eligible_at_beat: number;
}

// ============ CONSTANTS ============

/** Genesis seed — the "Big Bang" of Beat time */
export const BEAT_GENESIS_SEED = 'provenonce:beat:genesis:v1:2026';

/** Default difficulty: hash iterations per beat */
export const DEFAULT_DIFFICULTY = 1000;

/**
 * Minimum difficulty — even at minimum, each beat requires
 * sequential hashing that can't be parallelized
 */
export const MIN_DIFFICULTY = 100;

/** Maximum difficulty (prevents DoS via difficulty manipulation) */
export const MAX_DIFFICULTY = 1_000_000;

/** Global anchor interval — new anchor every N seconds */
export const GLOBAL_ANCHOR_INTERVAL_SEC = 60; // 1 minute

/** Check-in deadline — agents must check in within N global anchors */
export const CHECKIN_DEADLINE_ANCHORS = 60; // ~1 hour at 1-min anchors

/** Epoch length — difficulty adjusts every N global anchors */
export const EPOCH_LENGTH = 100; // ~100 minutes at 1-min anchors

/** Anchor hash grace window — how many recent anchors are valid for beat computation */
export const ANCHOR_HASH_GRACE_WINDOW = 5; // ~5 min at 1-min anchors

/** Base gestation cost — beats required to spawn one child agent */
export const BASE_GESTATION_BEATS = 1_000;

/** Gestation multiplier per depth level (deeper = more expensive) */
export const GESTATION_DEPTH_MULTIPLIER = 1.5;

/** Max children per gestation window */
export const MAX_SPAWNS_PER_WINDOW = 10;

// ============ SEQUENTIAL HASH CHAIN ENGINE ============

/**
 * Compute a single beat.
 *
 * This is the core primitive — a sequential SHA-256 hash chain.
 * Each "beat" requires `difficulty` sequential hash operations.
 * Because SHA-256 is inherently sequential (output of hash N
 * is the input to hash N+1), this cannot be parallelized.
 *
 * This is the "physically unskippable amount of CPU work" that
 * proves an agent has "lived" through a specific time window.
 */
export function computeBeat(
  prevHash: string,
  beatIndex: number,
  difficulty: number = DEFAULT_DIFFICULTY,
  nonce?: string,
  anchorHash?: string,
): Beat {
  const timestamp = Date.now();

  // Seed: previous hash + beat index + optional nonce + optional anchor hash
  // Anchor hash weaving binds beats to the global clock, preventing pre-computation
  const seed = anchorHash
    ? `${prevHash}:${beatIndex}:${nonce || ''}:${anchorHash}`
    : `${prevHash}:${beatIndex}:${nonce || ''}`;

  let current = createHash('sha256')
    .update(seed, 'utf8')
    .digest('hex');

  // Sequential hash chain: hash `difficulty` times
  for (let i = 0; i < difficulty; i++) {
    current = createHash('sha256')
      .update(current, 'utf8')
      .digest('hex');
  }

  return {
    index: beatIndex,
    hash: current,
    prev: prevHash,
    timestamp,
    nonce,
    anchor_hash: anchorHash,
  };
}

/**
 * Verify a beat by recomputing the hash chain.
 * Returns true if the beat hash matches the expected output.
 *
 * This is the key property: verification costs the same as computation.
 * No shortcuts, no acceleration — the verifier must walk the same chain.
 */
export function verifyBeat(
  beat: Beat,
  difficulty: number = DEFAULT_DIFFICULTY,
): boolean {
  const recomputed = computeBeat(beat.prev, beat.index, difficulty, beat.nonce, beat.anchor_hash);
  return recomputed.hash === beat.hash;
}

/**
 * Compute a sequence of Beats (a "pulse").
 * Used by agents to accumulate proof-of-existence.
 */
export function computeBeats(
  startHash: string,
  startIndex: number,
  count: number,
  difficulty: number = DEFAULT_DIFFICULTY,
  anchorHash?: string,
): Beat[] {
  const beats: Beat[] = [];
  let prevHash = startHash;

  for (let i = 0; i < count; i++) {
    const beat = computeBeat(prevHash, startIndex + i, difficulty, undefined, anchorHash);
    beats.push(beat);
    prevHash = beat.hash;
  }

  return beats;
}

/**
 * Verify a chain of Beats by spot-checking.
 * Rather than verifying every beat (expensive), we verify
 * deterministically-selected samples + the endpoints. If any fail, the chain is invalid.
 */
export function verifyBeatChain(
  beats: Beat[],
  difficulty: number = DEFAULT_DIFFICULTY,
  spotCheckCount: number = 3,
): { valid: boolean; checked: number; failed: number[] } {
  if (beats.length === 0) return { valid: true, checked: 0, failed: [] };

  const failed: number[] = [];
  const toCheck = new Set<number>();

  // Always check first and last
  toCheck.add(0);
  toCheck.add(beats.length - 1);

  // Deterministic spot checks (anti-retry):
  // Public endpoints should not use random sampling that a prover can retry until it passes.
  // Derive pseudo-random indices from immutable chain features so selection is stable per input.
  const wanted = Math.max(0, Math.min(Math.floor(spotCheckCount), beats.length));
  if (wanted > toCheck.size) {
    const first = beats[0]?.hash || '';
    const last = beats[beats.length - 1]?.hash || '';
    let material = `${beats.length}:${difficulty}:${first}:${last}`;
    // Add some evenly-spaced deterministic points to reduce "hide faults in gaps".
    if (beats.length >= 4) {
      toCheck.add(Math.floor(beats.length / 2));
    }
    if (beats.length >= 8) {
      toCheck.add(Math.floor(beats.length / 4));
      toCheck.add(Math.floor((3 * beats.length) / 4));
    }
    while (toCheck.size < wanted) {
      material = createHash('sha256').update(material, 'utf8').digest('hex');
      const idx = parseInt(material.slice(0, 8), 16) % beats.length;
      toCheck.add(idx);
    }
  }

  // Verify chain linkage (prev hash matches)
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].prev !== beats[i - 1].hash) {
      failed.push(i);
    }
  }

  // Verify hash chain for spot-checked beats
  Array.from(toCheck).forEach(idx => {
    if (!verifyBeat(beats[idx], difficulty)) {
      failed.push(beats[idx].index);
    }
  });

  return {
    valid: failed.length === 0,
    checked: toCheck.size + beats.length - 1, // linkage + spot checks
    failed,
  };
}

// ============ GENESIS ============

/**
 * Create the genesis beat for an agent.
 * Derived deterministically from the agent's registration hash.
 * This is the "birth" of the agent's timeline.
 */
export function createGenesisBeat(agentHash: string): Beat {
  const genesisInput = `${BEAT_GENESIS_SEED}:${agentHash}`;
  const genesisHash = createHash('sha256').update(genesisInput, 'utf8').digest('hex');

  return {
    index: 0,
    hash: genesisHash,
    prev: '0'.repeat(64), // null hash
    timestamp: Date.now(),
  };
}

// ============ V3 BINARY HELPERS (private) ============

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a hex string to a Buffer. */
function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** Encode a number as 8-byte big-endian (u64be). */
function u64be(n: number): Buffer {
  const buf = Buffer.alloc(8);
  // Write as two 32-bit big-endian values (JS safe integers fit in 53 bits)
  buf.writeUInt32BE(Math.floor(n / 0x100000000), 0);
  buf.writeUInt32BE(n >>> 0, 4);
  return buf;
}

/** Decode a base58 string to a Buffer. */
function base58Decode(str: string): Buffer {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) map[BASE58_ALPHABET[i]] = i;
  let bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const val = map[str[i]];
    if (val === undefined) throw new Error('invalid base58 character');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

/**
 * V3 binary-canonical anchor hash.
 * Single SHA-256 over a fixed-layout 91-byte preimage:
 *   UTF8("PROVENONCE_BEATS_V1")  (19 bytes)
 *   hex_decode(prev_hash)         (32 bytes)
 *   u64be(beat_index)             (8 bytes)
 *   base58_decode(solana_entropy) (32 bytes)
 *
 * No difficulty iteration — single hash pass.
 */
export function computeAnchorHashV3(
  prevHash: string,
  beatIndex: number,
  solanaEntropy: string,
): string {
  const prefix = Buffer.from(ANCHOR_DOMAIN_PREFIX, 'utf8');  // 19 bytes
  const prev = hexToBytes(prevHash);                          // 32 bytes
  const idx = u64be(beatIndex);                               // 8 bytes
  const entropy = base58Decode(solanaEntropy);                // 32 bytes

  const preimage = Buffer.concat([prefix, prev, idx, entropy]);
  return createHash('sha256').update(preimage).digest('hex');
}

// ============ GLOBAL ANCHOR ============

/**
 * Generate a Global Anchor beat.
 * This is the "North Star" — published by the Beats service to
 * prevent long-term drift and provide UTC timestamp for temporal reference.
 *
 * V3: When solanaEntropy is present, uses binary-canonical hash (single SHA-256,
 * no difficulty iteration). When absent, falls back to v1 legacy string formula.
 */
export function createGlobalAnchor(
  prevAnchor: GlobalAnchor | null,
  difficulty: number = DEFAULT_DIFFICULTY,
  epoch: number = 0,
  solanaEntropy?: string,
): GlobalAnchor {
  const index = prevAnchor ? prevAnchor.beat_index + 1 : 0;
  const prevHash = prevAnchor?.hash || createHash('sha256').update(BEAT_GENESIS_SEED, 'utf8').digest('hex');
  const utc = Date.now();

  let hash: string;
  if (solanaEntropy) {
    // V3: binary-canonical hash — single SHA-256, no difficulty iteration
    hash = computeAnchorHashV3(prevHash, index, solanaEntropy);
  } else {
    // V1 legacy: string-based hash with difficulty iteration
    const nonce = `anchor:${utc}:${epoch}`;
    const beat = computeBeat(prevHash, index, difficulty, nonce);
    hash = beat.hash;
  }

  return {
    beat_index: index,
    hash,
    prev_hash: prevHash,
    utc,
    difficulty,
    epoch,
    solana_entropy: solanaEntropy,
  };
}

/**
 * Verify a Global Anchor.
 * V3: If solana_entropy is present, uses binary-canonical single SHA-256.
 * Otherwise falls back to v1 legacy string formula.
 */
export function verifyGlobalAnchor(anchor: GlobalAnchor): boolean {
  if (anchor.solana_entropy) {
    // V3: binary-canonical verification
    const expected = computeAnchorHashV3(anchor.prev_hash, anchor.beat_index, anchor.solana_entropy);
    return expected === anchor.hash;
  }
  // V1 legacy: string-based verification with difficulty iteration
  const nonce = `anchor:${anchor.utc}:${anchor.epoch}`;
  const beat = computeBeat(anchor.prev_hash, anchor.beat_index, anchor.difficulty, nonce);
  return beat.hash === anchor.hash;
}

// ============ GESTATION ============

/**
 * Calculate the gestation requirement for spawning a child agent.
 *
 * "An agent cannot simply 'spawn' 1,000 sub-agents instantly;
 *  it must prove it has expended the Beats (CPU cycles) required
 *  to 'birth' them."
 */
export function calculateGestationCost(
  parentDepth: number,
  childrenAlreadySpawned: number,
): number {
  // Base cost increases with depth (deeper agents are more expensive to spawn)
  const depthCost = Math.floor(
    BASE_GESTATION_BEATS * Math.pow(GESTATION_DEPTH_MULTIPLIER, parentDepth)
  );

  // Exponential backoff: each additional child costs more
  const spawnCost = Math.floor(depthCost * Math.pow(1.2, childrenAlreadySpawned));

  return spawnCost;
}

/**
 * Check if an agent has accumulated enough beats to spawn.
 */
export function checkGestationEligibility(
  parentBeats: number,
  parentDepth: number,
  childrenSpawned: number,
): GestationRequirement & { parent_hash: string } {
  const required = calculateGestationCost(parentDepth, childrenSpawned);

  return {
    parent_hash: '', // Filled in by caller
    required_beats: required,
    accumulated_beats: parentBeats,
    met: parentBeats >= required,
    spawn_eligible_at_beat: required,
  };
}

// ============ CHECK-IN ============

/**
 * Create a check-in proof for the registry.
 *
 * "To remain on the Whitelist, an agent must periodically
 *  submit a proof of its Local Beats to the Registry."
 */
export function createCheckinProof(
  agentHash: string,
  chain: Beat[],
  fromBeat: number,
  toBeat: number,
  globalAnchorIndex: number,
  spotCheckCount: number = 5,
): BeatProof {
  // Select beats within the proof window
  const windowBeats = chain.filter(b => b.index >= fromBeat && b.index <= toBeat);

  if (windowBeats.length === 0) {
    throw new Error(`No beats found in range [${fromBeat}, ${toBeat}]`);
  }

  // Generate spot checks (random beats within the window for verification)
  // prev and nonce are required for hash-chain recomputation on the verifier side
  const spotChecks: { index: number; hash: string; prev: string; nonce?: string }[] = [];
  const available = windowBeats.filter(b => b.index > fromBeat && b.index < toBeat);

  // Always include the endpoint beat so `to_hash` is actually verified by recomputation.
  // (Verifier requires this; see verifyCheckinProof M-4 fix.)
  const end = windowBeats[windowBeats.length - 1];
  if (end && end.index === toBeat) {
    spotChecks.push({ index: end.index, hash: end.hash, prev: end.prev, nonce: end.nonce });
  }

  for (let i = 0; i < Math.min(spotCheckCount, available.length); i++) {
    const idx = Math.floor(Math.random() * available.length);
    const beat = available[idx];
    spotChecks.push({ index: beat.index, hash: beat.hash, prev: beat.prev, nonce: beat.nonce });
    available.splice(idx, 1); // Don't pick the same one twice
  }

  return {
    agent_hash: agentHash,
    from_beat: fromBeat,
    to_beat: toBeat,
    from_hash: windowBeats[0].hash,
    to_hash: windowBeats[windowBeats.length - 1].hash,
    beats_computed: toBeat - fromBeat,
    global_anchor: globalAnchorIndex,
    spot_checks: spotChecks,
  };
}

/**
 * Verify a check-in proof.
 *
 * The registry verifies:
 *   1. Structural consistency (beat count, forward progression)
 *   2. Spot-check hash-chain recomputation (recompute hashes to confirm work was done)
 *
 * This is the real verification — not just structure checks,
 * but actual SHA-256 chain recomputation on spot-checked beats.
 */
export function verifyCheckinProof(
  proof: BeatProof,
  difficulty: number = DEFAULT_DIFFICULTY,
): { valid: boolean; reason?: string; spot_checks_verified?: number } {
  // Verify beat count is reasonable
  if (proof.beats_computed !== proof.to_beat - proof.from_beat) {
    return { valid: false, reason: 'Beat count mismatch' };
  }

  // Verify non-negative progression
  if (proof.to_beat <= proof.from_beat) {
    return { valid: false, reason: 'Beat range must be forward-moving' };
  }

  // C-1 fix: Require minimum spot checks when beats were computed
  if (proof.beats_computed > 0) {
    const minRequired = Math.min(3, proof.beats_computed);
    const provided = proof.spot_checks?.length || 0;
    if (provided < minRequired) {
      return {
        valid: false,
        reason: `Insufficient spot checks: got ${provided}, need at least ${minRequired}`,
      };
    }
  }

  // M-4 fix: Require to_beat index as a spot check so the final hash is verified
  if (proof.beats_computed > 0 && proof.spot_checks) {
    const hasEndpoint = proof.spot_checks.some(sc => sc.index === proof.to_beat);
    if (!hasEndpoint) {
      return {
        valid: false,
        reason: `Spot checks must include to_beat index (${proof.to_beat}) to verify final hash`,
      };
    }
  }

  // Verify spot checks by recomputing hash chain
  let spotChecksVerified = 0;
  for (const check of proof.spot_checks || []) {
    if (!check.hash || check.hash.length !== 64) {
      return { valid: false, reason: `Invalid hash at beat ${check.index}` };
    }

    // prev is required for hash-chain recomputation — reject spot checks without it
    if (!check.prev) {
      return {
        valid: false,
        reason: `Spot check at beat ${check.index} missing prev hash (required for hash-chain verification)`,
      };
    }

    const beatToVerify: Beat = {
      index: check.index,
      hash: check.hash,
      prev: check.prev,
      timestamp: 0,
      nonce: check.nonce,
      anchor_hash: proof.anchor_hash,
    };

    if (!verifyBeat(beatToVerify, difficulty)) {
      return {
        valid: false,
        reason: `Hash-chain verification failed at beat ${check.index}: recomputed hash does not match`,
      };
    }
    spotChecksVerified++;
  }

  return { valid: true, spot_checks_verified: spotChecksVerified };
}

// ============ RE-SYNC ============

/**
 * Generate a Re-Sync Challenge for an agent that went offline.
 *
 * "When an agent powers down, its time 'freezes.' Upon waking,
 *  it must perform a Re-Sync Challenge with the Registry to fill
 *  the 'Temporal Gap' and re-establish its provenance."
 */
export function createResyncChallenge(
  agentHash: string,
  lastKnownBeat: Beat,
  currentGlobalAnchor: GlobalAnchor,
  gapBeats: number, // How many beats the agent missed
): {
  challenge_nonce: string;
  required_beats: number;
  start_from: string;
  sync_to_global: number;
} {
  // The agent must compute `gapBeats` to fill the temporal gap
  // Plus a penalty based on how long they were offline
  const penalty = Math.floor(gapBeats * 0.1); // 10% penalty

  // Challenge nonce prevents replay attacks
  const challengeNonce = createHash('sha256')
    .update(`resync:${agentHash}:${lastKnownBeat.hash}:${currentGlobalAnchor.hash}:${Date.now()}`, 'utf8')
    .digest('hex');

  return {
    challenge_nonce: challengeNonce,
    required_beats: gapBeats + penalty,
    start_from: lastKnownBeat.hash,
    sync_to_global: currentGlobalAnchor.beat_index,
  };
}

// ============ DIFFICULTY ADJUSTMENT ============

/**
 * Adjust difficulty based on actual vs target beat rate.
 * Similar to Bitcoin's difficulty adjustment, this ensures
 * beats take a consistent real-world time regardless of
 * hardware improvements.
 */
export function adjustDifficulty(
  currentDifficulty: number,
  actualTimeMs: number,   // How long the last epoch actually took
  targetTimeMs: number,   // How long it should have taken
): number {
  const ratio = targetTimeMs / actualTimeMs;

  // Clamp adjustment to 4x in either direction (prevents wild swings)
  const clampedRatio = Math.max(0.25, Math.min(4.0, ratio));

  const newDifficulty = Math.floor(currentDifficulty * clampedRatio);

  return Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDifficulty));
}

// ============ UTILITY ============

/**
 * Estimate time to compute N beats at given difficulty.
 * Based on ~1μs per SHA-256 hash on modern hardware.
 */
export function estimateBeatTimeMs(count: number, difficulty: number): number {
  const hashesPerBeat = difficulty;
  const microsPerHash = 1; // Approximate
  return (count * hashesPerBeat * microsPerHash) / 1000;
}

/**
 * Format a beat index as a human-readable Beat timestamp.
 * e.g., "Beat #1,234 (Epoch 2, Difficulty 1000)"
 */
export function formatBeat(beat: Beat | number, epoch?: number, difficulty?: number): string {
  const index = typeof beat === 'number' ? beat : beat.index;
  let str = `Beat #${index.toLocaleString()}`;
  if (epoch !== undefined) str += ` (E${epoch})`;
  if (difficulty !== undefined) str += ` [D${difficulty}]`;
  return str;
}



