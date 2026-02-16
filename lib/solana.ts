import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { GlobalAnchor } from './beat';
import { parseAnchorMemo, selectCanonicalAnchor } from './anchor-canonical.js';

// ============ CONFIG ============

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

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
      commitment: 'confirmed',
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
    preflightCommitment: 'confirmed',
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
}

// ============ WRITE ANCHOR TO SOLANA ============

export async function sendAnchorMemo(
  anchor: AnchorMemoData
): Promise<{ signature: string; slot: number }> {
  const connection = getConnection();
  const anchorWallet = getAnchorKeypair();

  const memoJson = JSON.stringify(anchor);
  const memoBytes = Buffer.from(memoJson, 'utf-8');

  if (memoBytes.length > 566) {
    throw new Error(`Anchor memo too large: ${memoBytes.length} bytes (max 566)`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

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
    { limit: 50 }
  );

  const candidates: Array<GlobalAnchor & { tx_signature: string }> = [];

  for (const sig of signatures) {
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
      signature: sig.signature,
      tx_signature: sig.signature,
    });
  }

  return selectCanonicalAnchor(candidates);
}

export function getExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${SOLANA_CLUSTER}`;
}
