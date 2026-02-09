export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  type AnchorMemoData,
} from '@/lib/solana';

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
  if (cronSecret) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      console.warn('[Cron /anchor] Unauthorized cron call');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
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

    const epoch = prevAnchor ? prevAnchor.epoch : 0;
    const difficulty = prevAnchor ? prevAnchor.difficulty : DEFAULT_DIFFICULTY;
    const newAnchor = createGlobalAnchor(prevAnchor, difficulty, epoch);

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
