export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { GLOBAL_ANCHOR_INTERVAL_SEC } from '@/lib/beat';
import { readLatestAnchor, getExplorerUrl, getReceiptPublicKeyBase58, signReceipt } from '@/lib/solana';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

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
      }, { headers: CORS_HEADERS });
    }

    const receiptPayload: Record<string, unknown> = {
      type: 'anchor',
      beat_index: latest.beat_index,
      hash: latest.hash,
      prev_hash: latest.prev_hash,
      utc: latest.utc,
      difficulty: latest.difficulty,
      epoch: latest.epoch,
      tx_signature: latest.tx_signature,
    };
    if (latest.solana_entropy) receiptPayload.solana_entropy = latest.solana_entropy;
    const receiptSig = signReceipt(receiptPayload);

    const anchorBody: Record<string, unknown> = {
      type: 'anchor',
      beat_index: latest.beat_index,
      hash: latest.hash,
      prev_hash: latest.prev_hash,
      utc: latest.utc,
      difficulty: latest.difficulty,
      epoch: latest.epoch,
      tx_signature: latest.tx_signature,
    };
    if (latest.solana_entropy) anchorBody.solana_entropy = latest.solana_entropy;

    return NextResponse.json({
      anchor: anchorBody,
      on_chain: {
        tx_signature: latest.tx_signature,
        explorer_url: getExplorerUrl(latest.tx_signature),
        anchored: true,
      },
      receipt: {
        signature: receiptSig.signature_base64,
        public_key: getReceiptPublicKeyBase58(),
      },
      anchor_interval_sec: GLOBAL_ANCHOR_INTERVAL_SEC,
      next_anchor_at: new Date(
        latest.utc + GLOBAL_ANCHOR_INTERVAL_SEC * 1000
      ).toISOString(),
      _info: 'Anchor is the latest global beat. receipt.signature is Ed25519 over the anchor payload for offline verification.',
    }, { headers: CORS_HEADERS });

  } catch (err: any) {
    console.error('[Beat /anchor] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
  }
}

