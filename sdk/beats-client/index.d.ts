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

export interface BeatsClient {
  getHealth(): Promise<any>;
  getAnchor(opts?: AnchorOptions): Promise<any>;
  getKey(): Promise<any>;
  verify(payload: unknown): Promise<any>;
  timestampHash(hash: string): Promise<any>;
  verifyReceipt(response: any): Promise<boolean>;
  verifyOnChain(txSignature: string, opts?: VerifyOnChainOptions): Promise<VerifyOnChainResult>;
}

export declare function createBeatsClient(options?: BeatsClientOptions): BeatsClient;

