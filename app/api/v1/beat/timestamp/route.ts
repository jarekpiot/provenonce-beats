import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { RateLimiter, getClientIp, rateLimitResponse } from '@/lib/rate-limit';
import { readLatestAnchorCached, sendAnchorMemo, getExplorerUrl, signReceipt, getReceiptPublicKeyBase58, getAnchorBalanceLamports } from '@/lib/solana';

export const maxDuration = 60;

const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60 * 1000 });
const dailyLimiter = new RateLimiter({ maxRequests: 10, windowMs: 24 * 60 * 60 * 1000 });
const proLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60 * 1000 });
const proDailyLimiter = new RateLimiter({ maxRequests: 500, windowMs: 24 * 60 * 60 * 1000 });
const MAX_BODY_BYTES = 256;
const MIN_ANCHOR_BALANCE_LAMPORTS = 5_000;
const HASH_REGEX = /^[0-9a-f]{64}$/;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Beats-Tier-Token',
} as const;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function isValidProTierToken(req: NextRequest): boolean {
  const configured = process.env.BEATS_PRO_TIER_TOKEN;
  if (!configured) return false;
  const provided = req.headers.get('x-beats-tier-token');
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/v1/beat/timestamp
 *
 * Stateless hash timestamping:
 * - validates caller hash input
 * - references the current on-chain anchor
 * - writes a timestamp memo to Solana
 * - returns tx reference + signed receipt
 */
export async function POST(req: NextRequest) {
  const tier = isValidProTierToken(req) ? 'pro' : 'free';
  const ip = getClientIp(req);
  const rl = tier === 'pro' ? proLimiter.check(ip) : limiter.check(ip);
  if (!rl.allowed) {
    const blocked = rateLimitResponse(rl.resetAt);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => blocked.headers.set(k, v));
    return blocked;
  }
  const daily = tier === 'pro' ? proDailyLimiter.check(ip) : dailyLimiter.check(ip);
  if (!daily.allowed) {
    const blocked = NextResponse.json(
      { error: `Daily timestamp quota exceeded for ${tier} tier. Please try again tomorrow.` },
      { status: 429, headers: { ...CORS_HEADERS, 'Retry-After': String(Math.ceil((daily.resetAt - Date.now()) / 1000)) } },
    );
    return blocked;
  }

  const contentType = req.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415, headers: CORS_HEADERS });
  }

  const contentLength = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413, headers: CORS_HEADERS });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS_HEADERS });
  }

  const hashRaw = String(body?.hash ?? '').trim().toLowerCase();
  if (!HASH_REGEX.test(hashRaw)) {
    return NextResponse.json({ error: 'hash must be exactly 64 lowercase hex characters' }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const anchor = await readLatestAnchorCached(10_000);
    if (!anchor) {
      return NextResponse.json({ error: 'No anchor available on-chain yet' }, { status: 503, headers: CORS_HEADERS });
    }

    const timestampUtc = Date.now();
    const memo = {
      v: 1 as const,
      type: 'timestamp' as const,
      hash: hashRaw,
      anchor_index: anchor.beat_index,
      anchor_hash: anchor.hash,
      utc: timestampUtc,
    };

    const anchorBalanceLamports = await getAnchorBalanceLamports();
    if (anchorBalanceLamports < MIN_ANCHOR_BALANCE_LAMPORTS) {
      return NextResponse.json(
        { error: 'Timestamp temporarily unavailable: anchor wallet balance too low' },
        { status: 503, headers: CORS_HEADERS },
      );
    }

    const { signature } = await sendAnchorMemo(memo);

    const receiptPayload = {
      type: 'timestamp' as const,
      hash: hashRaw,
      anchor_index: anchor.beat_index,
      anchor_hash: anchor.hash,
      utc: timestampUtc,
      tx_signature: signature,
    };
    const receiptSig = signReceipt(receiptPayload);
    console.info('[beat/timestamp] anchored', {
      hash_prefix: `${hashRaw.slice(0, 10)}...`,
      anchor_index: anchor.beat_index,
      tx_prefix: `${signature.slice(0, 10)}...`,
    });

    return NextResponse.json({
      timestamp: receiptPayload,
      on_chain: {
        tx_signature: signature,
        explorer_url: getExplorerUrl(signature),
      },
      receipt: {
        signature: receiptSig.signature_base64,
        public_key: getReceiptPublicKeyBase58(),
      },
      tier,
      _note: 'Canonical proof is the Solana transaction. Receipt signature is convenience verification. utc is Unix epoch milliseconds.',
    }, { headers: CORS_HEADERS });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to timestamp hash' },
      { status: 502, headers: CORS_HEADERS },
    );
  }
}
