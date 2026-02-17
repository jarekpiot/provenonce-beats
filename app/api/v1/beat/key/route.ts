import { NextResponse } from 'next/server';
import { getAnchorPublicKeyBase58, getAnchorPublicKeyHex } from '@/lib/solana';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export function GET() {
  return NextResponse.json({
    public_key_base58: getAnchorPublicKeyBase58(),
    public_key_hex: getAnchorPublicKeyHex(),
    algorithm: 'Ed25519',
    purpose: 'Beats response-signing convenience verification',
    _note: 'Canonical proof is the on-chain SPL Memo transaction.',
  }, { headers: CORS_HEADERS });
}

