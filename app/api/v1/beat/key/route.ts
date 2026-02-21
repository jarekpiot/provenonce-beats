import { NextResponse } from 'next/server';
import {
  getReceiptPublicKeyBase58,
  getReceiptPublicKeyHex,
  getWorkProofPublicKeyBase58,
  getWorkProofPublicKeyHex,
} from '@/lib/solana';

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
    // Default key (timestamp receipts) — kept for backward compatibility
    public_key_base58: getReceiptPublicKeyBase58(),
    public_key_hex: getReceiptPublicKeyHex(),
    algorithm: 'Ed25519',
    // Per-receipt-type keys
    keys: {
      timestamp: {
        public_key_base58: getReceiptPublicKeyBase58(),
        public_key_hex: getReceiptPublicKeyHex(),
        signing_context: 'provenonce:beats:timestamp-receipt:v1',
        purpose: 'Verify signatures on GET /anchor and POST /timestamp responses',
      },
      work_proof: {
        public_key_base58: getWorkProofPublicKeyBase58(),
        public_key_hex: getWorkProofPublicKeyHex(),
        signing_context: 'provenonce:beats:work-proof:v1',
        purpose: 'Verify signatures on POST /work-proof receipts',
      },
    },
    _note: 'Both keys are Ed25519, HKDF-derived from the anchor keypair with distinct info strings. Use keys.timestamp for anchor/timestamp receipts, keys.work_proof for work-proof receipts.',
  }, { headers: CORS_HEADERS });
}
