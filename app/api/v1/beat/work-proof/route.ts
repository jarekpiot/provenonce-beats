export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyBeat,
  MIN_DIFFICULTY,
  ANCHOR_HASH_GRACE_WINDOW,
  type Beat,
} from '@/lib/beat';
import {
  readLatestAnchorCached,
  signWorkProofReceipt,
  getWorkProofPublicKeyBase58,
} from '@/lib/solana';
import { RateLimiter, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60 * 1000 });
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

const PUBLIC_MAX_DIFFICULTY = 5000;
const PUBLIC_MAX_SPOT_CHECKS = 25;
const MIN_SPOT_CHECKS = 3;

const HEX64 = /^[0-9a-f]{64}$/i;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function invalid(reason: string) {
  return NextResponse.json({ valid: false, reason }, { headers: CORS_HEADERS });
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
 * Request body (two equivalent forms):
 *   { work_proof: { from_hash, to_hash, beats_computed, difficulty,
 *                   anchor_index, anchor_hash?, spot_checks[] } }
 *   -- OR flat (backward compat) --
 *   { from_hash, to_hash, beats_computed, difficulty,
 *     anchor_index, anchor_hash?, spot_checks[] }
 *
 * spot_checks entries: { index, hash, prev, nonce? }
 *
 * Signed receipt payload:
 *   type          "work_proof"
 *   beats_verified  integer  Beats claimed (not independently counted)
 *   difficulty    integer
 *   anchor_index  integer
 *   anchor_hash   string | null
 *   from_hash     string   Start-of-chain hash (caller's claim)
 *   to_hash       string   End-of-chain hash (caller's claim)
 *   utc           string   ISO 8601 server timestamp
 *
 * Receipt signature (Ed25519) covers canonical JSON of the payload.
 * The signature is embedded in the receipt object returned to the caller.
 * Signing key: HKDF("provenonce:beats:work-proof:v1") from anchor keypair.
 * Verify using the work_proof key from GET /api/v1/beat/key.
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

  // Accept both { work_proof: {...} } wrapper and flat body (backward compat)
  const wp = body?.work_proof ?? body;

  // ── Required field extraction ────────────────────────────────────────

  const fromHash = typeof wp?.from_hash === 'string' ? wp.from_hash.toLowerCase() : '';
  const toHash = typeof wp?.to_hash === 'string' ? wp.to_hash.toLowerCase() : '';
  const beatsComputed = wp?.beats_computed;
  const anchorIndex = wp?.anchor_index;
  const anchorHash = typeof wp?.anchor_hash === 'string' ? wp.anchor_hash.toLowerCase() : undefined;
  const spotChecks: unknown[] = Array.isArray(wp?.spot_checks) ? wp.spot_checks : [];

  // ── Structural validation (400 for malformed requests) ───────────────

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
  if (!Number.isInteger(beatsComputed) || beatsComputed < 1) {
    return NextResponse.json(
      { error: 'beats_computed must be a positive integer' },
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

  // ── Spot-check shape validation ──────────────────────────────────────

  for (let i = 0; i < spotChecks.length; i++) {
    const sc = spotChecks[i] as any;
    if (!Number.isInteger(sc?.index) || sc.index < 0) {
      return NextResponse.json(
        { error: `spot_checks[${i}].index must be a non-negative integer` },
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
        { error: `spot_checks[${i}].prev must be 64 hex characters` },
        { status: 400, headers: CORS_HEADERS },
      );
    }
  }

  // ── Logic validation (200 with valid:false) ──────────────────────────

  // Difficulty: reject if below minimum. Caller must use the right difficulty.
  const rawDifficulty = Number(wp?.difficulty ?? 0);
  if (!Number.isFinite(rawDifficulty) || !Number.isInteger(rawDifficulty) || rawDifficulty < MIN_DIFFICULTY) {
    return invalid('insufficient_difficulty');
  }
  const difficulty = Math.min(rawDifficulty, PUBLIC_MAX_DIFFICULTY);

  // Minimum spot checks: at least MIN_SPOT_CHECKS (or beats_computed if chain is tiny)
  const minRequired = Math.min(MIN_SPOT_CHECKS, beatsComputed);
  if (spotChecks.length < minRequired) {
    return invalid('insufficient_spot_checks');
  }

  // Count mismatch: span of spot-check indices must not exceed beats_computed.
  // Allows chains starting at any index — only the window width is checked.
  const scIndices = (spotChecks as any[]).map((sc) => sc.index as number);
  const minScIndex = Math.min(...scIndices);
  const maxScIndex = Math.max(...scIndices);
  if (maxScIndex - minScIndex > beatsComputed) {
    return invalid('count_mismatch');
  }

  // ── Anchor freshness check ───────────────────────────────────────────

  let currentAnchor: any;
  try {
    currentAnchor = await readLatestAnchorCached(10_000);
  } catch {
    currentAnchor = null;
  }

  if (currentAnchor) {
    const ageDelta = currentAnchor.beat_index - anchorIndex;
    if (ageDelta > ANCHOR_HASH_GRACE_WINDOW || anchorIndex > currentAnchor.beat_index) {
      return invalid('stale_anchor');
    }
  }
  // If no anchor available (cold-start), skip freshness and accept the proof.

  // ── Hash-chain recomputation ─────────────────────────────────────────

  const failed: number[] = [];
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
    }
  }

  if (failed.length > 0) {
    return invalid('spot_check_failed');
  }

  // ── Sign the work-proof receipt ──────────────────────────────────────

  const utc = new Date().toISOString();
  const receiptPayload: Record<string, unknown> = {
    type: 'work_proof',
    beats_verified: beatsComputed,
    difficulty,
    anchor_index: anchorIndex,
    anchor_hash: anchorHash ?? null,
    from_hash: fromHash,
    to_hash: toHash,
    utc,
  };

  const { signature_base64 } = signWorkProofReceipt(receiptPayload);

  console.info('[beat/work-proof] verified', {
    beats: beatsComputed,
    difficulty,
    anchor_index: anchorIndex,
    spot_checks: spotChecks.length,
  });

  return NextResponse.json(
    {
      valid: true,
      receipt: {
        ...receiptPayload,
        signature: signature_base64,
      },
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
        min_difficulty: MIN_DIFFICULTY,
        max_difficulty: PUBLIC_MAX_DIFFICULTY,
        min_spot_checks: MIN_SPOT_CHECKS,
        max_spot_checks: PUBLIC_MAX_SPOT_CHECKS,
        anchor_grace_window: ANCHOR_HASH_GRACE_WINDOW,
      },
      receipt_format: {
        type: 'work_proof',
        beats_verified: 'integer — beats claimed (spot-checks verified)',
        difficulty: 'integer',
        anchor_index: 'integer',
        anchor_hash: 'string | null',
        from_hash: 'string — caller-provided start hash',
        to_hash: 'string — caller-provided end hash',
        utc: 'string — ISO 8601 server timestamp',
        signature: 'string — base64 Ed25519 over canonical JSON of fields above',
      },
      _note: 'Verify the receipt signature using the work_proof key from GET /api/v1/beat/key.',
    },
    { headers: CORS_HEADERS },
  );
}
