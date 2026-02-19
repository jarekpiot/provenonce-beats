const DEFAULT_BASE_URL = 'https://beats.provenonce.dev';
const DEFAULT_TIMEOUT_MS = 30_000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = Object.fromEntries([...BASE58_ALPHABET].map((ch, i) => [ch, i]));
const CLUSTER_RPC = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};
const HEX64 = /^[0-9a-f]{64}$/i;
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// ============ UTILITIES ============

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
  if (HEX64.test(publicKey)) {
    return Uint8Array.from(Buffer.from(publicKey, 'hex'));
  }
  return decodeBase58(publicKey);
}

// ============ CRYPTOGRAPHIC VERIFICATION ============

async function verifyEd25519(payload, signatureBase64, publicKey) {
  const message = new TextEncoder().encode(toCanonicalJson(payload));
  const signature = Uint8Array.from(Buffer.from(signatureBase64, 'base64'));
  const keyBytes = decodePublicKeyBytes(publicKey);

  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const key = await subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
      return subtle.verify({ name: 'Ed25519' }, key, signature, message);
    } catch {
      // Ed25519 not supported in this subtle implementation, fall through to Node
    }
  }

  // Node.js fallback
  const { createPublicKey, verify } = await import('node:crypto');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const pubDer = Buffer.concat([spkiPrefix, Buffer.from(keyBytes)]);
  const key = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message), key, Buffer.from(signature));
}

/**
 * Recompute an anchor's hash from its fields (B-3).
 * Requires Node.js crypto — not available in browsers.
 * Returns true if the recomputed hash matches anchor.hash.
 */
async function recomputeAnchorHash(anchor) {
  if (!anchor || !HEX64.test(anchor.hash) || !HEX64.test(anchor.prev_hash)) return false;
  if (!Number.isInteger(anchor.beat_index) || anchor.beat_index < 0) return false;
  if (!Number.isInteger(anchor.difficulty) || anchor.difficulty <= 0) return false;
  if (!Number.isInteger(anchor.utc) || anchor.utc < 0) return false;
  if (!Number.isInteger(anchor.epoch) || anchor.epoch < 0) return false;

  const { createHash } = await import('node:crypto');
  const nonce = `anchor:${anchor.utc}:${anchor.epoch}`;
  const seed = `${anchor.prev_hash}:${anchor.beat_index}:${nonce}`;
  let current = createHash('sha256').update(seed, 'utf8').digest('hex');
  for (let i = 0; i < anchor.difficulty; i++) {
    current = createHash('sha256').update(current, 'utf8').digest('hex');
  }
  return current === anchor.hash;
}

// ============ ON-CHAIN VERIFICATION ============

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

/**
 * Fetch full transaction from Solana RPC and extract SPL Memo content (B-4).
 * Returns parsed memo data or null if no memo found.
 */
async function fetchTransactionMemo({ txSignature, rpcUrl, cluster = 'devnet', fetchImpl }) {
  const endpoint = rpcUrl || CLUSTER_RPC[cluster] || CLUSTER_RPC.devnet;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'getTransaction',
      params: [txSignature, { encoding: 'jsonParsed', commitment: 'finalized' }],
    }),
  });
  const body = await res.json();
  if (!res.ok || body?.error || !body?.result) return null;

  const instructions = body.result.transaction?.message?.instructions || [];
  for (const ix of instructions) {
    // SPL Memo can appear as programId or program field
    if (ix.programId === MEMO_PROGRAM_ID || ix.program === 'spl-memo') {
      const raw = ix.parsed || ix.data;
      if (!raw) continue;
      // Memo may have a Solana program prefix: "[program] JSON"
      let memoStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const bracketEnd = memoStr.indexOf('] ');
      if (bracketEnd !== -1 && memoStr.startsWith('[')) {
        memoStr = memoStr.slice(bracketEnd + 2);
      }
      try {
        return JSON.parse(memoStr);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ============ CLIENT FACTORY ============

export function createBeatsClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  pinnedPublicKey = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  // B-1: Key resolution state — pinned key has highest priority
  let _cachedKey = pinnedPublicKey || null;

  // B-2: Anchor continuity state
  let _lastAnchor = null;

  // Internal fetch with timeout (B-5)
  const fetchWithTimeout = async (url, init = {}) => {
    if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return fetchImpl(url, init);
  };

  const request = async (path, init = {}) => {
    const res = await fetchWithTimeout(`${baseUrl}${path}`, init);
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
    // ---- Health ----
    getHealth() {
      return request('/api/health');
    },

    // ---- Anchor (with continuity tracking B-2) ----
    async getAnchor(opts = {}) {
      const data = await request('/api/v1/beat/anchor');
      const anchor = data?.anchor;

      // B-2: Continuity validation against last known anchor
      if (anchor && _lastAnchor) {
        if (anchor.beat_index < _lastAnchor.beat_index) {
          const err = new Error(
            `Anchor chain regression: server returned beat_index ${anchor.beat_index}, ` +
            `but last known was ${_lastAnchor.beat_index}`
          );
          err.code = 'ANCHOR_REGRESSION';
          throw err;
        }
        // If consecutive, prev_hash must link
        if (anchor.beat_index === _lastAnchor.beat_index + 1) {
          if (anchor.prev_hash !== _lastAnchor.hash) {
            const err = new Error(
              `Anchor chain break at beat_index ${anchor.beat_index}: ` +
              `prev_hash ${anchor.prev_hash} does not match last known hash ${_lastAnchor.hash}`
            );
            err.code = 'ANCHOR_CHAIN_BREAK';
            throw err;
          }
        }
      }

      // B-1: Receipt verification with pinned/cached key (never response key)
      if (opts.verify === true) {
        const ok = await this.verifyAnchor(data);
        if (!ok) throw new Error('Anchor receipt verification failed');
        data._verified_receipt = true;
      }

      // B-3: Optional hash recomputation
      if (opts.recompute === true && anchor) {
        const hashValid = await recomputeAnchorHash(anchor);
        if (!hashValid) throw new Error('Anchor hash recomputation failed — server returned invalid hash');
        data._verified_hash = true;
      }

      // Update continuity state
      if (anchor) _lastAnchor = { ...anchor };

      return data;
    },

    // ---- Key ----
    getKey() {
      return request('/api/v1/beat/key');
    },

    // ---- Verify (server-side) ----
    verify(payload) {
      return request('/api/v1/beat/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },

    // ---- Timestamp ----
    timestampHash(hash) {
      return request('/api/v1/beat/timestamp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
    },

    // ---- Receipt Verification (B-1: key pinning) ----
    async verifyReceipt(response, opts = {}) {
      const payload = response?.timestamp || response?.anchor || response?.payload;
      const signature = response?.receipt?.signature || response?.signature;
      if (!payload || !signature) return false;

      // B-1: Key resolution priority — param > pinned > cached > auto-fetch
      // NEVER use response.receipt.public_key for verification
      const key = opts.publicKey || _cachedKey || await this._resolveKey();
      if (!key) return false;

      try {
        return await verifyEd25519(payload, signature, key);
      } catch {
        return false;
      }
    },

    async verifyAnchor(anchorResponse) {
      if (!anchorResponse?.anchor || !anchorResponse?.receipt) return false;
      return this.verifyReceipt(anchorResponse);
    },

    // ---- Anchor Hash Recomputation (B-3) ----
    verifyAnchorHash(anchor) {
      return recomputeAnchorHash(anchor);
    },

    // ---- On-Chain Verification (B-4: memo content check) ----
    async verifyOnChain(txSignature, opts = {}) {
      const rpcUrl = opts.rpcUrl || CLUSTER_RPC[opts.cluster || 'devnet'];
      const status = await verifyOnChainTx({
        txSignature,
        rpcUrl,
        cluster: opts.cluster || 'devnet',
        fetchImpl: fetchWithTimeout,
      });

      if (!status.found || !status.finalized) return status;

      // B-4: If expectedPayload provided, fetch tx and verify memo content
      if (opts.expectedPayload) {
        const memo = await fetchTransactionMemo({
          txSignature,
          rpcUrl,
          cluster: opts.cluster || 'devnet',
          fetchImpl: fetchWithTimeout,
        });

        if (!memo) {
          return { ...status, memoVerified: false, reason: 'No SPL Memo instruction found in transaction' };
        }

        const expected = opts.expectedPayload;
        // Compare critical anchor fields
        const memoMatch = (
          (expected.hash === undefined || memo.hash === expected.hash) &&
          (expected.beat_index === undefined || memo.beat_index === expected.beat_index) &&
          (expected.prev_hash === undefined || memo.prev === expected.prev_hash) &&
          (expected.utc === undefined || memo.utc === expected.utc) &&
          (expected.difficulty === undefined || memo.difficulty === expected.difficulty) &&
          (expected.epoch === undefined || memo.epoch === expected.epoch) &&
          // Timestamp memo fields
          (expected.anchor_index === undefined || memo.anchor_index === expected.anchor_index) &&
          (expected.anchor_hash === undefined || memo.anchor_hash === expected.anchor_hash)
        );

        return { ...status, memoVerified: memoMatch, memoData: memo };
      }

      return status;
    },

    // ---- Continuity State (B-2) ----
    setLastKnownAnchor(anchor) {
      if (anchor && typeof anchor.beat_index === 'number' && HEX64.test(anchor.hash)) {
        _lastAnchor = { ...anchor };
      }
    },

    getLastKnownAnchor() {
      return _lastAnchor ? { ..._lastAnchor } : null;
    },

    // ---- Internal: Key Resolution (B-1) ----
    async _resolveKey() {
      if (_cachedKey) return _cachedKey;
      try {
        const keyData = await this.getKey();
        // Prefer hex (more portable) over base58
        _cachedKey = keyData.public_key_hex || keyData.public_key_base58;
        return _cachedKey;
      } catch {
        return null;
      }
    },
  };
}
