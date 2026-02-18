import { NextRequest, NextResponse } from 'next/server';
import {
  verifyBeat,
  verifyBeatChain,
  verifyCheckinProof,
  DEFAULT_DIFFICULTY,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  type Beat,
} from '@/lib/beat';
import { RateLimiter, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60 * 1000 });
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

// Public verifier cost-guards: keep worst-case compute bounded for serverless.
const PUBLIC_MAX_DIFFICULTY = 5000;
const PUBLIC_MAX_SPOT_CHECKS = 25;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * POST /api/v1/beat/verify
 *
 * PUBLIC - no auth required.
 * Stateless sequential-work proof verification.
 *
 * Modes:
 *   beat  - verify a single beat (full hash-chain recomputation)
 *   chain - verify a chain of beats (spot-check + linkage)
 *   proof - verify a checkin proof (endpoint + spot check recomputation)
 */
export async function POST(req: NextRequest) {
  const rl = limiter.check(getClientIp(req));
  if (!rl.allowed) {
    const blocked = rateLimitResponse(rl.resetAt);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => blocked.headers.set(k, v));
    return blocked;
  }

  try {
    const body = await req.json();
    const mode = body.mode || 'beat';
    const requestedDifficultyRaw = Number(body.difficulty ?? DEFAULT_DIFFICULTY);
    const requestedDifficulty = Number.isFinite(requestedDifficultyRaw) ? requestedDifficultyRaw : DEFAULT_DIFFICULTY;
    const difficulty = Math.min(
      Math.max(requestedDifficulty, MIN_DIFFICULTY),
      Math.min(MAX_DIFFICULTY, PUBLIC_MAX_DIFFICULTY),
    );

    if (mode === 'beat') {
      const beat: Beat = body.beat;

      if (!beat || typeof beat.index !== 'number' || !beat.hash || !beat.prev) {
        return NextResponse.json({
          error: 'Missing beat fields: index, hash, prev required',
        }, { status: 400, headers: CORS_HEADERS });
      }

      const valid = verifyBeat(beat, difficulty);

      return NextResponse.json({
        ok: true,
        mode: 'beat',
        valid,
        beat_index: beat.index,
        difficulty,
        hash_operations: difficulty,
        _note: valid
          ? 'Beat verified: hash-chain recomputation matches claimed hash.'
          : 'Beat INVALID: recomputed hash does not match.',
      }, { headers: CORS_HEADERS });
    }

    if (mode === 'chain') {
      const beats: Beat[] = body.beats;
      const requestedSpotChecks = Number(body.spot_checks ?? 3);
      const spotChecks = Math.min(
        Math.max(Number.isFinite(requestedSpotChecks) ? Math.floor(requestedSpotChecks) : 3, 0),
        PUBLIC_MAX_SPOT_CHECKS,
      );

      if (!beats || !Array.isArray(beats) || beats.length === 0) {
        return NextResponse.json({
          error: 'Missing or empty beats array',
        }, { status: 400, headers: CORS_HEADERS });
      }

      if (beats.length > 1000) {
        return NextResponse.json({
          error: 'Chain too long for inline verification (max 1000 beats). Submit in segments.',
        }, { status: 400, headers: CORS_HEADERS });
      }

      const result = verifyBeatChain(beats, difficulty, spotChecks);

      return NextResponse.json({
        ok: true,
        mode: 'chain',
        valid: result.valid,
        chain_length: beats.length,
        beats_checked: result.checked,
        failed_indices: result.failed,
        difficulty,
        total_hash_operations: result.checked * difficulty,
        _note: result.valid
          ? `Chain verified: ${result.checked} beats spot-checked, all valid.`
          : `Chain INVALID: ${result.failed.length} beats failed verification.`,
      }, { headers: CORS_HEADERS });
    }

    if (mode === 'proof') {
      const proof = body.proof;

      if (!proof || typeof proof.from_beat !== 'number' || !proof.to_beat || !proof.from_hash || !proof.to_hash) {
        return NextResponse.json({
          error: 'Missing proof fields: from_beat, to_beat, from_hash, to_hash required',
        }, { status: 400, headers: CORS_HEADERS });
      }

      const providedSpotChecks = proof.spot_checks?.length ?? 0;
      if (providedSpotChecks > PUBLIC_MAX_SPOT_CHECKS) {
        return NextResponse.json({
          error: `Too many spot checks (max ${PUBLIC_MAX_SPOT_CHECKS})`,
        }, { status: 400, headers: CORS_HEADERS });
      }

      if (proof.to_beat <= proof.from_beat) {
        return NextResponse.json({
          ok: true,
          mode: 'proof',
          valid: false,
          reason: 'Beat range must be forward-moving',
        }, { headers: CORS_HEADERS });
      }

      if (proof.beats_computed !== undefined && proof.beats_computed !== proof.to_beat - proof.from_beat) {
        return NextResponse.json({
          ok: true,
          mode: 'proof',
          valid: false,
          reason: 'Beat count mismatch',
        }, { headers: CORS_HEADERS });
      }

      const result = verifyCheckinProof(proof, difficulty);

      return NextResponse.json({
        ok: true,
        mode: 'proof',
        valid: result.valid,
        reason: result.reason,
        from_beat: proof.from_beat,
        to_beat: proof.to_beat,
        beats_claimed: proof.to_beat - proof.from_beat,
        spot_checks_verified: result.spot_checks_verified || 0,
        difficulty,
        _note: result.valid
          ? `Proof verified: ${result.spot_checks_verified || 0} spot checks passed hash-chain recomputation.`
          : `Proof INVALID: ${result.reason || 'verification failed'}.`,
      }, { headers: CORS_HEADERS });
    }

    return NextResponse.json({
      error: `Unknown mode '${mode}'. Use 'beat', 'chain', or 'proof'.`,
    }, { status: 400, headers: CORS_HEADERS });

  } catch (err: any) {
    console.error('[Beat /verify] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
  }
}

/**
 * GET /api/v1/beat/verify
 * Service info - public, no auth.
 */
export async function GET() {
  return NextResponse.json({
    service: 'Provenonce Beats',
    description: 'Stateless public utility for verifying sequential-work beat proofs.',
    stateless: true,
    auth_required: false,
    modes: {
      beat: 'Verify a single beat (full hash-chain recomputation)',
      chain: 'Verify a chain of beats (spot-check + linkage)',
      proof: 'Verify a checkin proof (endpoint + spot check recomputation)',
    },
    difficulty: {
      default: DEFAULT_DIFFICULTY,
      min: MIN_DIFFICULTY,
      max: MAX_DIFFICULTY,
      public_max: PUBLIC_MAX_DIFFICULTY,
    },
    public_caps: {
      max_spot_checks: PUBLIC_MAX_SPOT_CHECKS,
    },
    _note: 'Beats has no concept of identity. It verifies sequential computational work for anyone.',
  }, { headers: CORS_HEADERS });
}


