const DEFAULT_BASE_URL = 'https://beats.provenonce.dev';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = Object.fromEntries([...BASE58_ALPHABET].map((ch, i) => [ch, i]));
const CLUSTER_RPC = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

function toCanonicalJson(value) {
  const keys = Object.keys(value).sort();
  const out = {};
  for (const key of keys) out[key] = value[key];
  return JSON.stringify(out);
}

function decodeBase58(str) {
  if (!str || typeof str !== 'string') throw new Error('base58 value required');
  let bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const val = BASE58_MAP[str[i]];
    if (val === undefined) throw new Error('invalid base58 character');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function decodePublicKeyBytes(publicKey) {
  if (typeof publicKey !== 'string' || publicKey.length === 0) {
    throw new Error('receipt public key is required');
  }
  if (/^[0-9a-f]{64}$/i.test(publicKey)) {
    return Uint8Array.from(Buffer.from(publicKey, 'hex'));
  }
  return decodeBase58(publicKey);
}

async function verifyEd25519(payload, signatureBase64, publicKey) {
  const message = new TextEncoder().encode(toCanonicalJson(payload));
  const signature = Uint8Array.from(Buffer.from(signatureBase64, 'base64'));
  const keyBytes = decodePublicKeyBytes(publicKey);

  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const key = await subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
    return subtle.verify({ name: 'Ed25519' }, key, signature, message);
  }

  // Node fallback for environments without WebCrypto subtle.
  const { createPublicKey, verify } = await import('node:crypto');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const pubDer = Buffer.concat([spkiPrefix, Buffer.from(keyBytes)]);
  const key = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message), key, Buffer.from(signature));
}

async function verifyOnChainTx({
  txSignature,
  rpcUrl,
  cluster = 'devnet',
  fetchImpl,
}) {
  if (typeof txSignature !== 'string' || txSignature.length === 0) {
    throw new Error('txSignature is required');
  }
  const endpoint = rpcUrl || CLUSTER_RPC[cluster] || CLUSTER_RPC.devnet;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignatureStatuses',
      params: [[txSignature], { searchTransactionHistory: true }],
    }),
  });
  const body = await res.json();
  if (!res.ok || body?.error) {
    throw new Error(`RPC verification failed for ${txSignature}`);
  }
  const status = body?.result?.value?.[0] || null;
  return {
    found: !!status,
    confirmationStatus: status?.confirmationStatus || null,
    finalized: status?.confirmationStatus === 'finalized',
    slot: status?.slot ?? null,
  };
}

export function createBeatsClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const request = async (path, init = {}) => {
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  return {
    getHealth() {
      return request('/api/health');
    },
    async getAnchor(opts = {}) {
      const anchor = await request('/api/v1/beat/anchor');
      if (opts.verify === true) {
        const ok = await this.verifyAnchor(anchor);
        if (!ok) throw new Error('Anchor receipt verification failed');
        return { ...anchor, _verified_receipt: true };
      }
      return anchor;
    },
    getKey() {
      return request('/api/v1/beat/key');
    },
    verify(payload) {
      return request('/api/v1/beat/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    timestampHash(hash) {
      return request('/api/v1/beat/timestamp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
    },
    async verifyReceipt(response) {
      const payload = response?.timestamp || response?.anchor || response?.payload;
      const signature = response?.receipt?.signature || response?.signature;
      const publicKey = response?.receipt?.public_key || response?.public_key;
      if (!payload || !signature || !publicKey) return false;
      try {
        return await verifyEd25519(payload, signature, publicKey);
      } catch {
        return false;
      }
    },
    async verifyAnchor(anchorResponse) {
      if (!anchorResponse?.anchor || !anchorResponse?.receipt) return false;
      return this.verifyReceipt(anchorResponse);
    },
    async verifyOnChain(txSignature, opts = {}) {
      return verifyOnChainTx({
        txSignature,
        rpcUrl: opts.rpcUrl,
        cluster: opts.cluster || 'devnet',
        fetchImpl,
      });
    },
  };
}
