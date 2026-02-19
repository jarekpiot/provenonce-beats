export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  createGlobalAnchor,
  GLOBAL_ANCHOR_INTERVAL_SEC,
  DEFAULT_DIFFICULTY,
  type GlobalAnchor,
} from '@/lib/beat';
import {
  readLatestAnchor,
  sendAnchorMemo,
  getFinalizedBlockhash,
  type AnchorMemoData,
} from '@/lib/solana';

function constantTimeSecretEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    const padded = Buffer.alloc(expectedBuf.length);
    providedBuf.copy(padded, 0, 0, Math.min(providedBuf.length, expectedBuf.length));
    timingSafeEqual(padded, expectedBuf);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * GET /api/cron/anchor
 *
 * Vercel Cron handler — advances the global beat anchor.
 * Called every minute by Vercel's cron scheduler.
 *
 * Reads the previous anchor from Solana, computes the next one,
 * and writes it back to Solana as a memo. No database.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.warn('[Cron /anchor] CRON_SECRET not configured - rejecting request');
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
  }
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !constantTimeSecretEqual(authHeader, `Bearer ${cronSecret}`)) {
    console.warn('[Cron /anchor] Unauthorized cron call');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();

  try {
    const latest = await readLatestAnchor();

    const now = Date.now();
    const age = latest ? now - latest.utc : Infinity;
    const stale = !latest || age > GLOBAL_ANCHOR_INTERVAL_SEC * 1000;

    if (!stale) {
      const nextAt = new Date(latest!.utc + GLOBAL_ANCHOR_INTERVAL_SEC * 1000);
      console.log(`[Cron /anchor] Anchor #${latest!.beat_index} still fresh (${(age / 1000).toFixed(0)}s old). Next at ${nextAt.toISOString()}`);
      return NextResponse.json({
        ok: true,
        action: 'skipped',
        reason: 'anchor_still_fresh',
        beat_index: latest!.beat_index,
        age_sec: Math.round(age / 1000),
        next_at: nextAt.toISOString(),
      });
    }

    // Build new anchor from previous on-chain state
    const prevAnchor: GlobalAnchor | null = latest ? {
      beat_index: latest.beat_index,
      hash: latest.hash,
      prev_hash: latest.prev_hash,
      utc: latest.utc,
      difficulty: latest.difficulty,
      epoch: latest.epoch,
    } : null;

    // A-4: Fetch finalized Solana blockhash as external entropy.
    // Fail closed: if entropy is unavailable, do NOT advance the anchor head.
    const solanaEntropy = await getFinalizedBlockhash();
    if (!solanaEntropy) {
      console.error('[Cron /anchor] Failed to fetch Solana blockhash — refusing to advance anchor (fail-closed)');
      return NextResponse.json(
        { ok: false, error: 'Solana entropy unavailable — anchor not advanced' },
        { status: 503 }
      );
    }

    const epoch = prevAnchor ? prevAnchor.epoch : 0;
    const difficulty = prevAnchor ? prevAnchor.difficulty : DEFAULT_DIFFICULTY;
    const newAnchor = createGlobalAnchor(prevAnchor, difficulty, epoch, solanaEntropy);

    // Write to Solana — this IS the persistence
    const anchorMemo: AnchorMemoData = {
      v: 1,
      type: 'anchor',
      beat_index: newAnchor.beat_index,
      hash: newAnchor.hash,
      prev: newAnchor.prev_hash,
      utc: newAnchor.utc,
      difficulty: newAnchor.difficulty,
      epoch: newAnchor.epoch,
      solana_entropy: solanaEntropy,
    };

    const { signature } = await sendAnchorMemo(anchorMemo);

    const elapsed = Date.now() - t0;
    console.log(`[Cron /anchor] Anchor #${newAnchor.beat_index} written to Solana in ${elapsed}ms: ${signature}`);

    return NextResponse.json({
      ok: true,
      action: 'generated',
      beat_index: newAnchor.beat_index,
      hash: newAnchor.hash,
      tx_signature: signature,
      elapsed_ms: elapsed,
    });

  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`[Cron /anchor] Error after ${elapsed}ms:`, err.message);
    return NextResponse.json(
      { ok: false, error: err.message, elapsed_ms: elapsed },
      { status: 500 }
    );
  }
}
