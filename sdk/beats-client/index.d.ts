export interface ContinuityState {
  beat_index: number;
  hash: string;
  agent_id: string | null;
}

export interface BeatsClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Pin a known public key for receipt verification (B-1). Hex or base58. */
  pinnedPublicKey?: string | null;
  /** Request timeout in milliseconds (B-5). Default: 30000. */
  timeoutMs?: number;
  /** Callback when continuity state changes. Persist this for restart recovery. */
  onStateChange?: (state: ContinuityState) => void;
  /** Load persisted continuity state on startup. */
  loadState?: () => ContinuityState | null;
  /** Agent ID for scoping persisted state. */
  agentId?: string | null;
}

export interface VerifyOnChainOptions {
  rpcUrl?: string;
  cluster?: 'devnet' | 'testnet' | 'mainnet-beta';
  /** If provided, fetches the full transaction and verifies SPL Memo content matches (B-4). */
  expectedPayload?: Record<string, unknown>;
}

export interface VerifyOnChainResult {
  found: boolean;
  confirmationStatus: string | null;
  finalized: boolean;
  slot: number | null;
  /** True if memo content matches expectedPayload (B-4). Only present when expectedPayload is provided. */
  memoVerified?: boolean;
  /** Parsed memo data from the transaction (B-4). */
  memoData?: Record<string, unknown>;
  /** Reason if memoVerified is false. */
  reason?: string;
}

export interface VerifyReceiptOptions {
  /** Override key for this specific verification. Hex or base58. */
  publicKey?: string;
}

export interface AnchorOptions {
  /** Verify receipt signature against pinned/cached key (B-1). */
  verify?: boolean;
  /** Recompute anchor hash locally via SHA-256 chain (B-3, Node.js only). */
  recompute?: boolean;
}

export interface HealthResponse {
  status?: string;
  [key: string]: unknown;
}

export interface BeatAnchor {
  beat_index: number;
  hash: string;
  prev_hash: string;
  utc: number;
  difficulty: number;
  epoch: number;
  tx_signature: string;
  /** A-4: Finalized Solana blockhash used as external entropy. Present on v2 anchors. */
  solana_entropy?: string;
}

export interface ReceiptEnvelope {
  signature: string;
  public_key: string;
}

export interface AnchorResponse {
  anchor: BeatAnchor | null;
  on_chain: {
    tx_signature: string | null;
    explorer_url: string | null;
    anchored?: boolean;
  };
  receipt?: ReceiptEnvelope;
  anchor_interval_sec?: number;
  next_anchor_at?: string;
  _verified_receipt?: boolean;
  _verified_hash?: boolean;
  _note?: string;
  _info?: string;
}

export interface TimestampPayload {
  hash: string;
  anchor_index: number;
  anchor_hash: string;
  utc: number;
  tx_signature: string;
}

export interface TimestampResponse {
  timestamp: TimestampPayload;
  on_chain: {
    tx_signature: string;
    explorer_url: string;
  };
  receipt: ReceiptEnvelope;
  tier?: 'free' | 'pro';
  _note?: string;
}

export interface VerifyApiResponse {
  ok?: boolean;
  mode?: 'beat' | 'chain' | 'proof';
  valid?: boolean;
  error?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface BeatsClient {
  getHealth(): Promise<HealthResponse>;
  getAnchor(opts?: AnchorOptions): Promise<AnchorResponse>;
  getKey(): Promise<{ public_key_base58: string; public_key_hex: string; algorithm: string; purpose?: string; _note?: string }>;
  verify(payload: unknown): Promise<VerifyApiResponse>;
  timestampHash(hash: string): Promise<TimestampResponse>;

  /** Verify receipt signature against pinned/cached/fetched key (B-1). Never uses response-embedded key. */
  verifyReceipt(response: AnchorResponse | TimestampResponse | { payload: Record<string, unknown>; signature: string; public_key: string }, opts?: VerifyReceiptOptions): Promise<boolean>;
  verifyAnchor(anchorResponse: AnchorResponse): Promise<boolean>;

  /** Recompute anchor hash from fields via SHA-256 chain (B-3, Node.js only). */
  verifyAnchorHash(anchor: BeatAnchor): Promise<boolean>;

  /** Verify on-chain tx status and optionally SPL Memo content (B-4). */
  verifyOnChain(txSignature: string, opts?: VerifyOnChainOptions): Promise<VerifyOnChainResult>;

  /** Set last known anchor for continuity tracking (B-2). Throws if chain is broken. */
  setLastKnownAnchor(anchor: BeatAnchor): void;
  /** Get last known anchor (B-2). Returns null if no anchor has been seen. */
  getLastKnownAnchor(): BeatAnchor | null;
  /** Re-establish chain continuity after a break. Requires explicit operator action. */
  resync(anchor: BeatAnchor): void;
  /** Returns true if chain continuity is broken and resync() is required. */
  isBroken(): boolean;

  /** Internal: resolve public key from cache or auto-fetch. */
  _resolveKey(): Promise<string | null>;
}

export declare function createBeatsClient(options?: BeatsClientOptions): BeatsClient;
