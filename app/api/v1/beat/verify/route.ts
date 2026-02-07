import { NextRequest, NextResponse } from 'next/server';
import {
  verifyBeat,
  verifyBeatChain,
  DEFAULT_DIFFICULTY,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  type Beat,
} from '@/lib/beat';
import { RateLimiter, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60 * 1000 });

/**
 * POST /api/v1/beat/verify
 *
 * PUBLIC — no auth required.
 * Stateless VDF proof verification.
 *
 * Modes:
 *   beat  — verify a single beat (full VDF recomputation)
 *   chain — verify a chain of beats (spot-check + linkage)
 *   proof — verify a checkin proof (endpoint + spot check VDF)
 */
export async function POST(req: NextRequest) {
  const rl = limiter.check(getClientIp(req));
  if (!rl.allowed) return rateLimitResponse(rl.resetAt);

  try {
    const body = await req.json();
    const mode = body.mode || 'beat';
    const difficulty = Math.min(
      Math.max(body.difficulty || DEFAULT_DIFFICULTY, MIN_DIFFICULTY),
      MAX_DIFFICULTY
    );

    // ── Mode 1: Verify a single beat ──
    if (mode === 'beat') {
      const beat: Beat = body.beat;

      if (!beat || typeof beat.index !== 'number' || !beat.hash || !beat.prev) {
        return NextResponse.json({
          error: 'Missing beat fields: index, hash, prev required',
        }, { status: 400 });
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
          ? 'Beat verified: VDF recomputation matches claimed hash.'
          : 'Beat INVALID: recomputed hash does not match.',
      });
    }

    // ── Mode 2: Verify a chain of beats ──
    if (mode === 'chain') {
      const beats: Beat[] = body.beats;
      const spotChecks = body.spot_checks || 3;

      if (!beats || !Array.isArray(beats) || beats.length === 0) {
        return NextResponse.json({
          error: 'Missing or empty beats array',
        }, { status: 400 });
      }

      if (beats.length > 1000) {
        return NextResponse.json({
          error: 'Chain too long for inline verification (max 1000 beats). Submit in segments.',
        }, { status: 400 });
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
      });
    }

    // ── Mode 3: Verify a checkin proof ──
    if (mode === 'proof') {
      const proof = body.proof;

      if (!proof || typeof proof.from_beat !== 'number' || !proof.to_beat || !proof.from_hash || !proof.to_hash) {
        return NextResponse.json({
          error: 'Missing proof fields: from_beat, to_beat, from_hash, to_hash required',
        }, { status: 400 });
      }

      if (proof.to_beat <= proof.from_beat) {
        return NextResponse.json({
          ok: true,
          mode: 'proof',
          valid: false,
          reason: 'Beat range must be forward-moving',
        });
      }

      if (proof.beats_computed !== undefined && proof.beats_computed !== proof.to_beat - proof.from_beat) {
        return NextResponse.json({
          ok: true,
          mode: 'proof',
          valid: false,
          reason: 'Beat count mismatch',
        });
      }

      const spotResults: { index: number; valid: boolean }[] = [];
      let allValid = true;

      if (proof.spot_checks && Array.isArray(proof.spot_checks)) {
        for (const check of proof.spot_checks) {
          if (!check.hash || !check.prev || typeof check.index !== 'number') {
            spotResults.push({ index: check.index || -1, valid: false });
            allValid = false;
            continue;
          }

          const beatToVerify: Beat = {
            index: check.index,
            hash: check.hash,
            prev: check.prev,
            timestamp: check.timestamp || 0,
            nonce: check.nonce,
          };

          const valid = verifyBeat(beatToVerify, difficulty);
          spotResults.push({ index: check.index, valid });
          if (!valid) allValid = false;
        }
      }

      return NextResponse.json({
        ok: true,
        mode: 'proof',
        valid: allValid,
        from_beat: proof.from_beat,
        to_beat: proof.to_beat,
        beats_claimed: proof.to_beat - proof.from_beat,
        spot_checks_verified: spotResults.length,
        spot_check_results: spotResults,
        difficulty,
        _note: allValid
          ? `Proof verified: ${spotResults.length} spot checks passed VDF recomputation.`
          : `Proof INVALID: one or more spot checks failed VDF recomputation.`,
      });
    }

    return NextResponse.json({
      error: `Unknown mode '${mode}'. Use 'beat', 'chain', or 'proof'.`,
    }, { status: 400 });

  } catch (err: any) {
    console.error('[Beat /verify] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * GET /api/v1/beat/verify
 * Service info — public, no auth.
 */
export async function GET() {
  return NextResponse.json({
    service: 'Provenonce Beats — Time Authentication',
    description: 'Stateless public utility for verifying VDF beat proofs.',
    stateless: true,
    auth_required: false,
    modes: {
      beat: 'Verify a single beat (full VDF recomputation)',
      chain: 'Verify a chain of beats (spot-check + linkage)',
      proof: 'Verify a checkin proof (endpoint + spot check VDF)',
    },
    difficulty: {
      default: DEFAULT_DIFFICULTY,
      min: MIN_DIFFICULTY,
      max: MAX_DIFFICULTY,
    },
    _note: 'Beats has no concept of identity. It authenticates time for anyone.',
  });
}
