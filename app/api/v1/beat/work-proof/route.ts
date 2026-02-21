import { NextRequest, NextResponse } from 'next/server';
import {
  verifyBeat,
  DEFAULT_DIFFICULTY,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  ANCHOR_HASH_GRACE_WINDOW,
  type Beat,
} from '@/lib/beat';
import {
  readLatestAnchorCached,
  signWorkProofReceipt,
  getWorkProofPublicKeyBase58,
} from '@/lib/solana';
import { RateLimiter, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

export const maxDuration = 30;

const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60 * 1000 });
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

const PUBLIC_MAX_DIFFICULTY = 5000;
const PUBLIC_MAX_SPOT_CHECKS = 25;
const HEX64 = /^[0-9a-f]{64}$/i;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * POST /api/v1/beat/work-proof
 *
 * Stateless work-proof verification. Validates that a caller has
 * performed N sequential SHA-256 beats at difficulty D, anchored
 * to a recent global beat. Returns a signed receipt on success.
 *
 * Policy-free: no cost formulas, no identity, no Registry concepts.
 * The caller (Registry or any consumer) decides what N means for
 * their use case.
 *
 * Request body:
 *   from_beat     integer  Starting beat index
 *   to_beat       integer  Ending beat index (exclusive upper bound)
 *   from_hash     hex64    Hash at from_beat
 *   to_hash       hex64    Hash at to_beat
 *   beats_computed integer to_beat - from_beat
 *   difficulty    integer  Hash iterations per beat
 *   anchor_index  integer  Global anchor index woven into beats
 *   anchor_hash   hex64    (optional) Anchor hash woven into beats
 *   spot_checks   array    Spot-checked beats for verification
 *     .index      integer  Beat index
 *     .hash       hex64    Hash at this beat
 *     .prev       hex64    Previous beat hash (required for recomputation)
 *     .nonce      string   (optional) Nonce used in this beat
 *
 * Signed receipt payload:
 *   type          "work_proof"
 *   beats_verified  integer  Beats confirmed by spot-check
 *   difficulty    integer
 *   anchor_index  integer
 *   anchor_hash   string | null
 *   utc           integer  Server timestamp (Unix ms)
 */
export async function POST(req: NextRequest) {
  const rl = limiter.check(getClientIp(req));
  if (!rl.allowed) {
    const blocked = rateLimitResponse(rl.resetAt);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => blocked.headers.set(k, v));
    return blocked;
  }

  const contentType = req.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    return NextResponse.json(
      { error: 'Content-Type must be application/json' },
      { status: 415, headers: CORS_HEADERS },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ── Structural validation ──────────────────────────────────────────

  const fromBeat = body?.from_beat;
  const toBeat = body?.to_beat;
  const fromHash = typeof body?.from_hash === 'string' ? body.from_hash.toLowerCase() : '';
  const toHash = typeof body?.to_hash === 'string' ? body.to_hash.toLowerCase() : '';
  const beatsComputed = body?.beats_computed;
  const anchorIndex = body?.anchor_index;
  const anchorHash = typeof body?.anchor_hash === 'string' ? body.anchor_hash.toLowerCase() : undefined;
  const spotChecks: unknown[] = Array.isArray(body?.spot_checks) ? body.spot_checks : [];

  if (!Number.isInteger(fromBeat) || fromBeat < 0) {
    return NextResponse.json(
      { error: 'from_beat must be a non-negative integer' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!Number.isInteger(toBeat) || toBeat <= fromBeat) {
    return NextResponse.json(
      { error: 'to_beat must be an integer greater than from_beat' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!HEX64.test(fromHash)) {
    return NextResponse.json(
      { error: 'from_hash must be 64 lowercase hex characters' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!HEX64.test(toHash)) {
    return NextResponse.json(
      { error: 'to_hash must be 64 lowercase hex characters' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!Number.isInteger(beatsComputed) || beatsComputed !== toBeat - fromBeat) {
    return NextResponse.json(
      { error: `beats_computed must equal to_beat - from_beat (expected ${toBeat - fromBeat})` },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!Number.isInteger(anchorIndex) || anchorIndex < 0) {
    return NextResponse.json(
      { error: 'anchor_index must be a non-negative integer' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (anchorHash !== undefined && !HEX64.test(anchorHash)) {
    return NextResponse.json(
      { error: 'anchor_hash must be 64 lowercase hex characters when provided' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // Clamp difficulty to safe range
  const rawDifficulty = Number(body?.difficulty ?? DEFAULT_DIFFICULTY);
  const difficulty = Number.isFinite(rawDifficulty)
    ? Math.min(Math.max(Math.floor(rawDifficulty), MIN_DIFFICULTY), PUBLIC_MAX_DIFFICULTY)
    : DEFAULT_DIFFICULTY;

  if (spotChecks.length === 0) {
    return NextResponse.json(
      { error: 'spot_checks must be a non-empty array' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (spotChecks.length > PUBLIC_MAX_SPOT_CHECKS) {
    return NextResponse.json(
      { error: `Too many spot checks (max ${PUBLIC_MAX_SPOT_CHECKS})` },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ── Spot-check shape validation ────────────────────────────────────

  for (let i = 0; i < spotChecks.length; i++) {
    const sc = spotChecks[i] as any;
    if (
      !Number.isInteger(sc?.index) ||
      sc.index < fromBeat ||
      sc.index > toBeat
    ) {
      return NextResponse.json(
        { error: `spot_checks[${i}].index must be an integer in [from_beat, to_beat]` },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    if (!HEX64.test(String(sc?.hash ?? ''))) {
      return NextResponse.json(
        { error: `spot_checks[${i}].hash must be 64 hex characters` },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    if (!HEX64.test(String(sc?.prev ?? ''))) {
      return NextResponse.json(
        { error: `spot_checks[${i}].prev must be 64 hex characters (required for recomputation)` },
        { status: 400, headers: CORS_HEADERS },
      );
    }
  }

  // M-4: spot_checks must include the final beat (to_beat) so the claimed
  // to_hash is actually verified by recomputation.
  const hasEndpoint = (spotChecks as any[]).some(sc => sc.index === toBeat);
  if (!hasEndpoint) {
    return NextResponse.json(
      { error: `spot_checks must include to_beat (index ${toBeat}) to verify the final hash` },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ── Anchor freshness check ─────────────────────────────────────────

  let currentAnchor: any;
  try {
    currentAnchor = await readLatestAnchorCached(10_000);
  } catch {
    currentAnchor = null;
  }

  if (currentAnchor) {
    const ageDelta = currentAnchor.beat_index - anchorIndex;
    if (ageDelta > ANCHOR_HASH_GRACE_WINDOW) {
      return NextResponse.json(
        {
          ok: true,
          valid: false,
          reason: `anchor_index ${anchorIndex} is too stale (current is ${currentAnchor.beat_index}, grace window is ${ANCHOR_HASH_GRACE_WINDOW})`,
        },
        { headers: CORS_HEADERS },
      );
    }
    if (anchorIndex > currentAnchor.beat_index) {
      return NextResponse.json(
        {
          ok: true,
          valid: false,
          reason: `anchor_index ${anchorIndex} is in the future (current is ${currentAnchor.beat_index})`,
        },
        { headers: CORS_HEADERS },
      );
    }
  }
  // If no anchor available (service cold-start), skip freshness check and
  // accept the proof. Callers bear the risk of stale anchors in degraded state.

  // ── Minimum spot-check count ───────────────────────────────────────

  const minRequired = Math.min(3, beatsComputed);
  if (spotChecks.length < minRequired) {
    return NextResponse.json(
      {
        ok: true,
        valid: false,
        reason: `Insufficient spot checks: provided ${spotChecks.length}, need at least ${minRequired}`,
      },
      { headers: CORS_HEADERS },
    );
  }

  // ── Hash-chain recomputation ───────────────────────────────────────

  const failed: number[] = [];
  let spotChecksVerified = 0;

  for (const sc of spotChecks as any[]) {
    const beat: Beat = {
      index: sc.index,
      hash: sc.hash,
      prev: sc.prev,
      timestamp: 0,
      nonce: sc.nonce,
      anchor_hash: anchorHash,
    };
    if (!verifyBeat(beat, difficulty)) {
      failed.push(sc.index);
    } else {
      spotChecksVerified++;
    }
  }

  if (failed.length > 0) {
    return NextResponse.json(
      {
        ok: true,
        valid: false,
        reason: `Hash-chain verification failed at beat ${failed[0]}: recomputed hash does not match`,
        failed_indices: failed,
      },
      { headers: CORS_HEADERS },
    );
  }

  // ── Sign the work-proof receipt ────────────────────────────────────

  const utc = Date.now();
  const receiptPayload: Record<string, unknown> = {
    type: 'work_proof',
    beats_verified: beatsComputed,
    difficulty,
    anchor_index: anchorIndex,
    anchor_hash: anchorHash ?? null,
    utc,
  };
  const { signature_base64 } = signWorkProofReceipt(receiptPayload);

  console.info('[beat/work-proof] verified', {
    beats: beatsComputed,
    difficulty,
    anchor_index: anchorIndex,
    spot_checks: spotChecksVerified,
  });

  return NextResponse.json(
    {
      ok: true,
      valid: true,
      receipt: receiptPayload,
      signature: signature_base64,
      public_key: getWorkProofPublicKeyBase58(),
      spot_checks_verified: spotChecksVerified,
      _note: 'Receipt is signed with the Beats work-proof key (distinct from timestamp key). Verify using public_key from GET /api/v1/beat/key.',
    },
    { headers: CORS_HEADERS },
  );
}

/**
 * GET /api/v1/beat/work-proof
 * Service info — public, no auth.
 */
export async function GET() {
  return NextResponse.json(
    {
      service: 'Provenonce Beats — Work Proof',
      description:
        'Stateless public utility. Validates N sequential SHA-256 beats at difficulty D, ' +
        'anchored to a recent global beat. Returns a signed receipt. Policy-free: no cost ' +
        'formulas, no identity. The caller decides what N means for their use case.',
      stateless: true,
      auth_required: false,
      endpoint: 'POST /api/v1/beat/work-proof',
      receipt_type: 'work_proof',
      signing_context: 'provenonce:beats:work-proof:v1',
      public_caps: {
        max_spot_checks: PUBLIC_MAX_SPOT_CHECKS,
        max_difficulty: PUBLIC_MAX_DIFFICULTY,
        anchor_grace_window: ANCHOR_HASH_GRACE_WINDOW,
      },
      _note: 'Verify the receipt signature using the work_proof public key from GET /api/v1/beat/key.',
    },
    { headers: CORS_HEADERS },
  );
}
