import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter, getClientIp, rateLimitResponse } from '@/lib/rate-limit';
import { readLatestAnchor, sendAnchorMemo, getExplorerUrl, signReceipt, getAnchorPublicKeyBase58 } from '@/lib/solana';

export const maxDuration = 60;

const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60 * 1000 });
const MAX_BODY_BYTES = 256;
const HASH_REGEX = /^[0-9a-f]{64}$/;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
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
  const rl = limiter.check(getClientIp(req));
  if (!rl.allowed) {
    const blocked = rateLimitResponse(rl.resetAt);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => blocked.headers.set(k, v));
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
    const anchor = await readLatestAnchor();
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

    const { signature } = await sendAnchorMemo(memo);

    const receiptPayload = {
      hash: hashRaw,
      anchor_index: anchor.beat_index,
      anchor_hash: anchor.hash,
      utc: timestampUtc,
      tx_signature: signature,
    };
    const receiptSig = signReceipt(receiptPayload);

    return NextResponse.json({
      timestamp: receiptPayload,
      on_chain: {
        tx_signature: signature,
        explorer_url: getExplorerUrl(signature),
      },
      receipt: {
        signature: receiptSig.signature_base64,
        public_key: getAnchorPublicKeyBase58(),
      },
      _note: 'Canonical proof is the Solana transaction. Receipt signature is convenience verification.',
    }, { headers: CORS_HEADERS });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to timestamp hash' },
      { status: 502, headers: CORS_HEADERS },
    );
  }
}

