import { NextResponse } from 'next/server';
import { getAnchorAddress, readLatestAnchorCached } from '@/lib/solana';

export async function GET() {
  try {
    const latest = await readLatestAnchorCached(10_000);
    const now = Date.now();
    const anchorAgeMs = latest ? Math.max(0, now - Number(latest.utc || now)) : null;
    const anchorIntervalMs = 60_000;
    const degraded = anchorAgeMs !== null ? anchorAgeMs > anchorIntervalMs * 3 : true;

    return NextResponse.json({
      service: 'provenonce-beats',
      status: degraded ? 'degraded' : 'ok',
      timestamp: new Date(now).toISOString(),
      anchor_signer: getAnchorAddress(),
      anchor: latest ? {
        beat_index: latest.beat_index,
        hash: latest.hash,
        utc: latest.utc,
        tx_signature: latest.tx_signature,
        age_ms: anchorAgeMs,
      } : null,
      timing: {
        anchor_interval_ms: anchorIntervalMs,
        anchor_stale_threshold_ms: anchorIntervalMs * 3,
      },
      operations: {
        log_drain_configured: process.env.VERCEL_LOG_DRAIN_CONFIGURED === '1',
        pro_tier_token_configured: !!process.env.BEATS_PRO_TIER_TOKEN,
      },
    });
  } catch (err: any) {
    return NextResponse.json({
      service: 'provenonce-beats',
      status: 'error',
      timestamp: new Date().toISOString(),
      error: err?.message || 'health check failed',
    }, { status: 503 });
  }
}
