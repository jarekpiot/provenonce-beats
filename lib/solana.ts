import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { GlobalAnchor } from './beat';

// ============ CONFIG ============

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const SOLANA_CLUSTER = 'devnet';

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    console.log(`[Beats] Creating Solana connection to ${SOLANA_CLUSTER}`, { rpcUrl: SOLANA_RPC_URL });
    _connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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

  const signature = await sendAndConfirmTransaction(connection, tx, [anchorWallet]);

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

  let best: (GlobalAnchor & { tx_signature: string }) | null = null;

  for (const sig of signatures) {
    if (!sig.memo) continue;

    try {
      // Solana prefixes memo with "[length] " — strip it
      let memoStr = sig.memo;
      const bracketEnd = memoStr.indexOf('] ');
      if (bracketEnd !== -1 && memoStr.startsWith('[')) {
        memoStr = memoStr.slice(bracketEnd + 2);
      }

      const parsed = JSON.parse(memoStr) as AnchorMemoData;
      if (parsed.v !== 1 || parsed.type !== 'anchor') continue;

      if (!best || parsed.beat_index > best.beat_index) {
        best = {
          beat_index: parsed.beat_index,
          hash: parsed.hash,
          prev_hash: parsed.prev,
          utc: parsed.utc,
          difficulty: parsed.difficulty,
          epoch: parsed.epoch,
          signature: sig.signature,
          tx_signature: sig.signature,
        };
      }
    } catch {
      // Not JSON or not an anchor — skip
    }
  }

  return best;
}

export function getExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${SOLANA_CLUSTER}`;
}
