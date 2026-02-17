export interface BeatsClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface BeatsClient {
  getHealth(): Promise<any>;
  getAnchor(): Promise<any>;
  getKey(): Promise<any>;
  verify(payload: unknown): Promise<any>;
  timestampHash(hash: string): Promise<any>;
}

export declare function createBeatsClient(options?: BeatsClientOptions): BeatsClient;

