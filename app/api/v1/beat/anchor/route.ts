export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { GLOBAL_ANCHOR_INTERVAL_SEC } from '@/lib/beat';
import { readLatestAnchor, getExplorerUrl } from '@/lib/solana';

/**
 * GET /api/v1/beat/anchor
 *
 * Returns the current Global Beat Anchor by reading from Solana.
 * No database — reads directly from the anchor wallet's on-chain memos.
 *
 * This is the "North Star" that agents sync to.
 */
export async function GET() {
  try {
    const latest = await readLatestAnchor();

    if (!latest) {
      return NextResponse.json({
        anchor: null,
        on_chain: { tx_signature: null, explorer_url: null, anchored: false },
        anchor_interval_sec: GLOBAL_ANCHOR_INTERVAL_SEC,
        _info: 'No anchor found on-chain. The cron has not run yet.',
      });
    }

    return NextResponse.json({
      anchor: {
        beat_index: latest.beat_index,
        hash: latest.hash,
        prev: latest.prev,
        utc: latest.utc,
        difficulty: latest.difficulty,
        epoch: latest.epoch,
      },
      on_chain: {
        tx_signature: latest.tx_signature,
        explorer_url: getExplorerUrl(latest.tx_signature),
        anchored: true,
      },
      anchor_interval_sec: GLOBAL_ANCHOR_INTERVAL_SEC,
      next_anchor_at: new Date(
        latest.utc + GLOBAL_ANCHOR_INTERVAL_SEC * 1000
      ).toISOString(),
      _info: 'NIST tells you what time it is. Provenonce tells the agent at what speed it is allowed to exist.',
    });

  } catch (err: any) {
    console.error('[Beat /anchor] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
