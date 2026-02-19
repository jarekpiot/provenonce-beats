import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { createPrivateKey, createPublicKey, hkdfSync, sign } from 'node:crypto';
import bs58 from 'bs58';
import type { GlobalAnchor } from './beat';
import { parseAnchorMemo, selectCanonicalAnchor } from './anchor-canonical.js';

// ============ CONFIG ============

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const RECEIPT_SIGNING_KEY_INFO = Buffer.from('provenonce:beats:timestamp-receipt:v1', 'utf8');

const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const SOLANA_CLUSTER = getSolanaClusterFromRpcUrl(SOLANA_RPC_URL);

function getSolanaClusterFromRpcUrl(rpcUrl: string): 'devnet' | 'testnet' | 'mainnet-beta' {
  const lower = rpcUrl.toLowerCase();
  if (lower.includes('devnet')) return 'devnet';
  if (lower.includes('testnet')) return 'testnet';
  return 'mainnet-beta';
}

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    console.log(`[Beats] Creating Solana connection to ${SOLANA_CLUSTER}`, { rpcUrl: SOLANA_RPC_URL });
    // Pass cache: 'no-store' to prevent Next.js from caching RPC responses.
    // Without this, confirmation polling gets cached results and never sees
    // the confirmed status — same issue as Registry's db-client.ts (Sprint 8).
    _connection = new Connection(SOLANA_RPC_URL, {
      commitment: 'finalized',
      fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }),
    });
  }
  return _connection;
}

function getAnchorKeypair(): Keypair {
  const secret = process.env.BEATS_ANCHOR_KEYPAIR;
  if (!secret) throw new Error('BEATS_ANCHOR_KEYPAIR not configured');
  return Keypair.fromSecretKey(bs58.decode(secret));
}

export function getAnchorAddress(): string {
  return getAnchorKeypair().publicKey.toBase58();
}

// ============ TX HELPERS ============

/**
 * Send a transaction and poll for confirmation via HTTP only.
 * Avoids WebSocket subscriptions which fail on Vercel serverless.
 */
async function sendAndConfirmTx(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  timeoutMs = 60_000,
  pollIntervalMs = 2_000,
): Promise<string> {
  tx.sign(...signers);
  const rawTx = tx.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'finalized',
  });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await connection.getSignatureStatuses([signature]);
    const status = resp?.value?.[0];
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === 'finalized') {
        return signature;
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
}

// ============ ANCHOR MEMO FORMAT ============

export interface AnchorMemoData {
  v: 1;
  type: 'anchor';
  beat_index: number;
  hash: string;
  prev: string;
  utc: number;
  difficulty: number;
  epoch: number;
  solana_entropy?: string;  // A-4: finalized blockhash used as external entropy
}

export interface TimestampMemoData {
  v: 1;
  type: 'timestamp';
  hash: string;
  anchor_index: number;
  anchor_hash: string;
  utc: number;
}

function canonicalJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const canonical: Record<string, unknown> = {};
  for (const key of keys) canonical[key] = value[key];
  return JSON.stringify(canonical);
}

export function getAnchorPublicKeyBase58(): string {
  return getReceiptPublicKeyBase58();
}

export function getAnchorPublicKeyHex(): string {
  return getReceiptPublicKeyHex();
}

function getReceiptPrivateKey() {
  const keypair = getAnchorKeypair();
  const anchorSeed = Buffer.from(keypair.secretKey.slice(0, 32));
  const derivedSeed = hkdfSync('sha256', anchorSeed, Buffer.alloc(0), RECEIPT_SIGNING_KEY_INFO, 32);
  const privKeyDer = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(derivedSeed)]);
  return createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
}

export function getReceiptPublicKeyHex(): string {
  const privateKey = getReceiptPrivateKey();
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki).subarray(-32).toString('hex');
}

export function getReceiptPublicKeyBase58(): string {
  return bs58.encode(Buffer.from(getReceiptPublicKeyHex(), 'hex'));
}

export function signReceipt(payload: Record<string, unknown>): { signature_base64: string } {
  const privateKey = getReceiptPrivateKey();
  const message = Buffer.from(canonicalJson(payload), 'utf8');
  const signature = sign(null, message, privateKey);
  return { signature_base64: signature.toString('base64') };
}

// ============ A-4: EXTERNAL ENTROPY ============

/**
 * Fetch a finalized Solana blockhash for use as external entropy in anchor derivation.
 * Commitment level: 'finalized' — highest consensus, cannot be rolled back.
 * Returns the base58-encoded blockhash string, or null on failure.
 */
export async function getFinalizedBlockhash(): Promise<string | null> {
  try {
    const connection = getConnection();
    const { blockhash } = await connection.getLatestBlockhash('finalized');
    return blockhash; // base58-encoded 32-byte hash
  } catch (err: any) {
    console.error('[Solana] getFinalizedBlockhash failed:', err.message);
    return null;
  }
}

// ============ WRITE ANCHOR TO SOLANA ============

export async function sendAnchorMemo(
  anchor: AnchorMemoData | TimestampMemoData
): Promise<{ signature: string; slot: number }> {
  const connection = getConnection();
  const anchorWallet = getAnchorKeypair();

  const memoJson = JSON.stringify(anchor);
  const memoBytes = Buffer.from(memoJson, 'utf-8');

  if (memoBytes.length > 566) {
    throw new Error(`Anchor memo too large: ${memoBytes.length} bytes (max 566)`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = anchorWallet.publicKey;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  tx.add(
    new TransactionInstruction({
      keys: [
        { pubkey: anchorWallet.publicKey, isSigner: true, isWritable: true },
      ],
      data: memoBytes,
      programId: MEMO_PROGRAM_ID,
    })
  );

  // HTTP polling only — no WebSocket on Vercel serverless
  const signature = await sendAndConfirmTx(connection, tx, [anchorWallet]);

  const txInfo = await connection.getTransaction(signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });

  return {
    signature,
    slot: txInfo?.slot || 0,
  };
}

// ============ READ LATEST ANCHOR FROM SOLANA ============

/**
 * Scan the anchor wallet's recent transactions for the latest anchor memo.
 * Returns the anchor with the highest beat_index, or null if none found.
 */
export async function readLatestAnchor(): Promise<
  (GlobalAnchor & { tx_signature: string }) | null
> {
  const connection = getConnection();
  const anchorWallet = getAnchorKeypair();

  const signatures = await connection.getSignaturesForAddress(
    anchorWallet.publicKey,
    { limit: 50 },
    'finalized'
  );

  const candidates: Array<GlobalAnchor & { tx_signature: string }> = [];

  for (const sig of signatures) {
    if (sig.confirmationStatus !== 'finalized') continue;
    if (!sig.memo) continue;
    const parsed = parseAnchorMemo(sig.memo);
    if (!parsed) continue;
    candidates.push({
      beat_index: parsed.beat_index,
      hash: parsed.hash,
      prev_hash: parsed.prev_hash,
      utc: parsed.utc,
      difficulty: parsed.difficulty,
      epoch: parsed.epoch,
      solana_entropy: parsed.solana_entropy,
      signature: sig.signature,
      tx_signature: sig.signature,
    });
  }

  return selectCanonicalAnchor(candidates);
}

let _anchorCache: { value: (GlobalAnchor & { tx_signature: string }) | null; expiresAt: number } | null = null;

export async function readLatestAnchorCached(ttlMs = 10_000): Promise<
  (GlobalAnchor & { tx_signature: string }) | null
> {
  const now = Date.now();
  if (_anchorCache && now < _anchorCache.expiresAt) return _anchorCache.value;
  const latest = await readLatestAnchor();
  _anchorCache = { value: latest, expiresAt: now + ttlMs };
  return latest;
}

export function getExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${SOLANA_CLUSTER}`;
}

export async function getAnchorBalanceLamports(): Promise<number> {
  const connection = getConnection();
  const anchorWallet = getAnchorKeypair();
  return connection.getBalance(anchorWallet.publicKey, 'finalized');
}
