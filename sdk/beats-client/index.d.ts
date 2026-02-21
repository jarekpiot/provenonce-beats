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
  /** Receipt type discriminator. Present on receipts signed by server v1.0+. */
  type?: 'anchor';
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
  /** Receipt type discriminator. Present on receipts signed by server v1.0+. */
  type?: 'timestamp';
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

export interface BeatObject {
  index: number;
  hash: string;
  prev: string;
  timestamp: number;
  nonce?: string;
  anchor_hash?: string;
}

export interface SpotCheck {
  index: number;
  hash: string;
  prev: string;
  nonce?: string;
}

export interface WorkProofRequest {
  /** Start-of-chain hash (64 hex). Caller-provided; included in signed receipt. */
  from_hash: string;
  /** End-of-chain hash (64 hex). Caller-provided; included in signed receipt. */
  to_hash: string;
  /** Number of beats in the work window. */
  beats_computed: number;
  /** Hash iterations per beat. Must be >= 100 (MIN_DIFFICULTY). */
  difficulty: number;
  /** Global anchor index referenced. Must be within grace window of current tip. */
  anchor_index: number;
  /** Anchor hash woven into beat computation (64 hex). */
  anchor_hash?: string;
  /** Random samples from the hash chain for spot-check recomputation. Min 3, max 25. */
  spot_checks: SpotCheck[];
}

export interface WorkProofReceiptPayload {
  type: 'work_proof';
  beats_verified: number;
  difficulty: number;
  anchor_index: number;
  anchor_hash: string | null;
  /** Start-of-chain hash as claimed by caller. */
  from_hash: string;
  /** End-of-chain hash as claimed by caller. */
  to_hash: string;
  /** ISO 8601 server timestamp. */
  utc: string;
  /** Base64 Ed25519 signature over canonical JSON of all other fields. */
  signature: string;
}

export interface WorkProofSuccessResponse {
  valid: true;
  receipt: WorkProofReceiptPayload;
}

export interface WorkProofFailureResponse {
  valid: false;
  reason: 'spot_check_failed' | 'stale_anchor' | 'insufficient_difficulty'
        | 'count_mismatch' | 'insufficient_spot_checks' | string;
}

export type WorkProofResponse = WorkProofSuccessResponse | WorkProofFailureResponse;

export interface KeyInfo {
  public_key_base58: string;
  public_key_hex: string;
  signing_context: string;
  purpose: string;
}

export interface KeyResponse {
  /** Timestamp receipt key (backward compat) */
  public_key_base58: string;
  public_key_hex: string;
  algorithm: string;
  keys: {
    timestamp: KeyInfo;
    work_proof: KeyInfo;
  };
  _note?: string;
}

export interface BeatsClient {
  getHealth(): Promise<HealthResponse>;
  getAnchor(opts?: AnchorOptions): Promise<AnchorResponse>;
  getKey(): Promise<KeyResponse>;
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

  /**
   * Submit a work proof to the Beats service and receive a signed receipt.
   *
   * The request is wrapped in { work_proof: ... } before sending.
   * The receipt certifies N beats at difficulty D anchored to a global beat.
   * Policy-free: the caller (Registry or any consumer) decides what N means.
   */
  submitWorkProof(proof: WorkProofRequest): Promise<WorkProofResponse>;

  /**
   * Verify a work-proof receipt signature offline.
   *
   * Extracts the embedded signature from receipt.signature, then verifies
   * the rest of the receipt payload using the work_proof HKDF key.
   * HKDF context: "provenonce:beats:work-proof:v1"
   *
   * Uses the work_proof key from GET /api/v1/beat/key (distinct from timestamp key).
   */
  verifyWorkProofReceipt(
    receiptResponse: WorkProofSuccessResponse,
    opts?: { publicKey?: string },
  ): Promise<boolean>;

  /** Internal: resolve public key from cache or auto-fetch. */
  _resolveKey(): Promise<string | null>;
}

export declare function createBeatsClient(options?: BeatsClientOptions): BeatsClient;

// ============ STANDALONE COMPUTE (Node.js only) ============

/**
 * Compute a single beat — sequential SHA-256 hash chain.
 * Node.js only (uses node:crypto). Not browser-compatible.
 *
 * @param prevHash    Previous beat hash (64 hex)
 * @param beatIndex   Beat index (monotonically increasing)
 * @param difficulty  Hash iterations per beat (default 1000)
 * @param nonce       Optional entropy
 * @param anchorHash  Optional global anchor hash to weave in
 */
export declare function computeBeat(
  prevHash: string,
  beatIndex: number,
  difficulty?: number,
  nonce?: string,
  anchorHash?: string,
): Promise<BeatObject>;

/**
 * Compute the genesis beat for a local chain.
 * Deterministic from caller-provided seed + domain prefix.
 * Node.js only.
 *
 * @param seed          Unique identifier (e.g. agent hash)
 * @param domainPrefix  Namespace prefix (default: 'beats:genesis:v1:')
 */
export declare function createGenesisBeat(
  seed: string,
  domainPrefix?: string,
): Promise<BeatObject>;
