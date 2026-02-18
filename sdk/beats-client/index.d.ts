export interface BeatsClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface VerifyOnChainOptions {
  rpcUrl?: string;
  cluster?: 'devnet' | 'testnet' | 'mainnet-beta';
}

export interface VerifyOnChainResult {
  found: boolean;
  confirmationStatus: string | null;
  finalized: boolean;
  slot: number | null;
}

export interface AnchorOptions {
  verify?: boolean;
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
  verifyReceipt(response: AnchorResponse | TimestampResponse | { payload: Record<string, unknown>; signature: string; public_key: string }): Promise<boolean>;
  verifyAnchor(anchorResponse: AnchorResponse): Promise<boolean>;
  verifyOnChain(txSignature: string, opts?: VerifyOnChainOptions): Promise<VerifyOnChainResult>;
}

export declare function createBeatsClient(options?: BeatsClientOptions): BeatsClient;

