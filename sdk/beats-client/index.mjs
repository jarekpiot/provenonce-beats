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
 * V3: If solana_entropy is present, uses binary-canonical single SHA-256.
 * V1 legacy: string-based hash with difficulty iteration (Node.js only).
 */
const ANCHOR_DOMAIN_PREFIX = 'PROVENONCE_BEATS_V1';

function hexToUint8Array(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}

function u64beBytes(n) {
  const buf = new Uint8Array(8);
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  buf[0] = (hi >>> 24) & 0xff;
  buf[1] = (hi >>> 16) & 0xff;
  buf[2] = (hi >>> 8) & 0xff;
  buf[3] = hi & 0xff;
  buf[4] = (lo >>> 24) & 0xff;
  buf[5] = (lo >>> 16) & 0xff;
  buf[6] = (lo >>> 8) & 0xff;
  buf[7] = lo & 0xff;
  return buf;
}

async function recomputeAnchorHash(anchor) {
  if (!anchor || !HEX64.test(anchor.hash) || !HEX64.test(anchor.prev_hash)) return false;
  if (!Number.isInteger(anchor.beat_index) || anchor.beat_index < 0) return false;
  if (!Number.isInteger(anchor.difficulty) || anchor.difficulty <= 0) return false;
  if (!Number.isInteger(anchor.utc) || anchor.utc < 0) return false;
  if (!Number.isInteger(anchor.epoch) || anchor.epoch < 0) return false;

  if (anchor.solana_entropy) {
    // V3: binary-canonical single SHA-256
    const prefix = new TextEncoder().encode(ANCHOR_DOMAIN_PREFIX);    // 19 bytes
    const prev = hexToUint8Array(anchor.prev_hash);                    // 32 bytes
    const idx = u64beBytes(anchor.beat_index);                         // 8 bytes
    const entropy = decodeBase58(anchor.solana_entropy);               // 32 bytes

    const preimage = new Uint8Array(prefix.length + prev.length + idx.length + entropy.length);
    preimage.set(prefix, 0);
    preimage.set(prev, prefix.length);
    preimage.set(idx, prefix.length + prev.length);
    preimage.set(entropy, prefix.length + prev.length + idx.length);

    // Web Crypto path
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      try {
        const digest = await subtle.digest('SHA-256', preimage);
        const hashArr = Array.from(new Uint8Array(digest));
        const computed = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
        return computed === anchor.hash;
      } catch {
        // Fall through to Node.js
      }
    }

    // Node.js fallback
    const { createHash } = await import('node:crypto');
    const computed = createHash('sha256').update(preimage).digest('hex');
    return computed === anchor.hash;
  }

  // V1 legacy: string-based hash with difficulty iteration
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
  onStateChange = null,
  loadState = null,
  agentId = null,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  // B-1: Key resolution state — pinned key has highest priority
  let _cachedKey = pinnedPublicKey || null;

  // B-2: Anchor continuity state
  let _lastAnchor = null;
  let _broken = false;
  let _breakReason = null;

  // Load persisted continuity state
  if (typeof loadState === 'function') {
    const saved = loadState();
    if (saved && typeof saved.beat_index === 'number' && HEX64.test(saved.hash)) {
      if (!agentId || saved.agent_id === agentId) {
        _lastAnchor = { beat_index: saved.beat_index, hash: saved.hash };
      }
    }
  }

  function _persistState(anchor) {
    if (typeof onStateChange === 'function' && anchor) {
      onStateChange({ beat_index: anchor.beat_index, hash: anchor.hash, agent_id: agentId || null });
    }
  }

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
      // Fail closed if chain is broken
      if (_broken) {
        const err = new Error(`Chain continuity broken: ${_breakReason}. Call resync() to re-establish.`);
        err.code = 'CHAIN_BROKEN';
        throw err;
      }

      const data = await request('/api/v1/beat/anchor');
      const anchor = data?.anchor;

      // B-2: Strict continuity validation against last known anchor
      if (anchor && _lastAnchor) {
        if (anchor.beat_index < _lastAnchor.beat_index) {
          _broken = true;
          _breakReason = `regression from ${_lastAnchor.beat_index} to ${anchor.beat_index}`;
          const err = new Error(
            `Anchor chain regression: server returned beat_index ${anchor.beat_index}, ` +
            `but last known was ${_lastAnchor.beat_index}`
          );
          err.code = 'ANCHOR_REGRESSION';
          throw err;
        }
        // Same beat_index: must be same hash (idempotent re-fetch)
        if (anchor.beat_index === _lastAnchor.beat_index) {
          if (anchor.hash !== _lastAnchor.hash) {
            _broken = true;
            _breakReason = `fork at beat_index ${anchor.beat_index}: hash changed`;
            const err = new Error(
              `Anchor chain fork at beat_index ${anchor.beat_index}: ` +
              `hash ${anchor.hash} differs from last known ${_lastAnchor.hash}`
            );
            err.code = 'ANCHOR_FORK';
            throw err;
          }
        } else if (anchor.beat_index === _lastAnchor.beat_index + 1) {
          // Consecutive: prev_hash must link
          if (anchor.prev_hash !== _lastAnchor.hash) {
            _broken = true;
            _breakReason = `prev_hash mismatch at beat_index ${anchor.beat_index}`;
            const err = new Error(
              `Anchor chain break at beat_index ${anchor.beat_index}: ` +
              `prev_hash ${anchor.prev_hash} does not match last known hash ${_lastAnchor.hash}`
            );
            err.code = 'ANCHOR_CHAIN_BREAK';
            throw err;
          }
        } else {
          // Non-consecutive jump: fail closed
          _broken = true;
          _breakReason = `beat_index jumped from ${_lastAnchor.beat_index} to ${anchor.beat_index}`;
          const err = new Error(
            `Anchor chain jump: beat_index ${anchor.beat_index} is not consecutive ` +
            `(expected ${_lastAnchor.beat_index + 1})`
          );
          err.code = 'ANCHOR_JUMP';
          throw err;
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

      // Update continuity state + persist
      if (anchor && (!_lastAnchor || anchor.beat_index > _lastAnchor.beat_index)) {
        _lastAnchor = { ...anchor };
        _persistState(_lastAnchor);
      }

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
      if (_broken) {
        throw new Error('Chain is broken. Call resync() to re-establish continuity.');
      }
      if (anchor && typeof anchor.beat_index === 'number' && HEX64.test(anchor.hash)) {
        _lastAnchor = { ...anchor };
        _persistState(_lastAnchor);
      }
    },

    getLastKnownAnchor() {
      return _lastAnchor ? { ..._lastAnchor } : null;
    },

    resync(anchor) {
      if (!anchor || typeof anchor.beat_index !== 'number' || !HEX64.test(anchor.hash)) {
        throw new Error('resync requires a valid anchor with beat_index and hash');
      }
      _broken = false;
      _breakReason = null;
      _lastAnchor = { ...anchor };
      _persistState(_lastAnchor);
    },

    isBroken() {
      return _broken;
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

    // ---- Work Proof ----

    /**
     * Submit a work proof to the Beats service and receive a signed receipt.
     *
     * The request is wrapped in a { work_proof: ... } envelope.
     *
     * @param {object} proof
     *   @param {string}   proof.from_hash      Start-of-chain hash (64 hex)
     *   @param {string}   proof.to_hash        End-of-chain hash (64 hex)
     *   @param {number}   proof.beats_computed Number of beats in window
     *   @param {number}   proof.difficulty     Hash iterations per beat (>= 100)
     *   @param {number}   proof.anchor_index   Global anchor index referenced
     *   @param {string}   [proof.anchor_hash]  Anchor hash woven into beats (64 hex)
     *   @param {Array}    proof.spot_checks    Spot-checked beats for recomputation
     *     @param {number}  .index              Beat index (absolute, as used in computeBeat)
     *     @param {string}  .hash               Hash at this beat (64 hex)
     *     @param {string}  .prev               Previous beat hash (64 hex)
     *     @param {string}  [.nonce]            Optional nonce used in computation
     *
     * @returns {Promise<{ valid: true, receipt: WorkProofReceiptPayload }
     *                  | { valid: false, reason: string }>}
     */
    submitWorkProof(proof) {
      return request('/api/v1/beat/work-proof', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ work_proof: proof }),
      });
    },

    /**
     * Verify a work-proof receipt signature offline.
     *
     * The signature is embedded inside receipt.signature.
     * Verification extracts the signature and verifies the rest of the
     * receipt payload using the work_proof HKDF key.
     *
     * Uses the work_proof key from GET /api/v1/beat/key (distinct from timestamp key).
     * HKDF context: "provenonce:beats:work-proof:v1"
     *
     * @param {object} receiptResponse  The full response from submitWorkProof()
     * @param {object} [opts]
     *   @param {string} [opts.publicKey]  Override: hex or base58 work-proof public key
     */
    async verifyWorkProofReceipt(receiptResponse, opts = {}) {
      const receipt = receiptResponse?.receipt;
      if (!receipt || typeof receipt !== 'object') return false;

      // Signature is embedded inside the receipt — extract it
      const { signature, ...payload } = receipt;
      if (!signature || typeof signature !== 'string') return false;

      // Resolve work-proof public key: param > cached from /key endpoint
      let key = opts.publicKey;
      if (!key) {
        try {
          const keyData = await this.getKey();
          key = keyData?.keys?.work_proof?.public_key_hex ||
                keyData?.keys?.work_proof?.public_key_base58;
        } catch {
          return false;
        }
      }
      if (!key) return false;

      try {
        return await verifyEd25519(payload, signature, key);
      } catch {
        return false;
      }
    },
  };
}

// ============ LOCAL BEAT CHAIN ============

export const BEATS_PER_ANCHOR = 100;
export const MAX_RESYNC_BEATS = 10_000;

function sampleEvenly(arr, count) {
  if (count <= 0 || arr.length === 0) return [];
  if (count >= arr.length) return [...arr];
  if (count === 1) return [arr[Math.floor(arr.length / 2)]];
  const result = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(i * (arr.length - 1) / (count - 1));
    result.push(arr[idx]);
  }
  return result;
}

/**
 * LocalBeatChain — agent-side sequential SHA-256 hash chain.
 *
 * Computes beats locally (no network required). Each beat is one sequential
 * SHA-256 hash chain of `difficulty` iterations. The chain anchors to global
 * Beats service anchors via anchor hash weaving.
 *
 * Usage:
 *   const chain = await LocalBeatChain.create({ seed: 'my-agent-id' });
 *   await chain.advance();
 *   const proof = chain.getProof();
 *   const result = await beats.submitWorkProof(proof);
 *
 * Node.js only (uses node:crypto via computeBeat).
 */
export class LocalBeatChain {
  #seed;
  #difficulty;
  #domainPrefix;
  #head;
  #genesis;
  #beatCount;
  #history;     // Array<{ index, hash, prev, anchor_hash }>
  #anchorIndex;
  #anchorHash;
  #maxHistory;
  #autoHandle;
  #autoRunning;

  constructor(genesis, opts = {}) {
    const {
      seed,
      difficulty = 1000,
      domainPrefix = 'beats:genesis:v1:',
      anchorIndex = 0,
      anchorHash = null,
      maxHistory = 500,
    } = opts;

    this.#seed = seed || genesis.hash;
    this.#difficulty = difficulty;
    this.#domainPrefix = domainPrefix;
    this.#anchorIndex = anchorIndex;
    this.#anchorHash = anchorHash;
    this.#maxHistory = maxHistory;
    this.#genesis = { index: genesis.index, hash: genesis.hash, prev: genesis.prev, anchor_hash: genesis.anchor_hash ?? null };
    this.#head = { ...this.#genesis };
    this.#beatCount = 0;
    this.#history = [{ ...this.#genesis }];
    this.#autoHandle = null;
    this.#autoRunning = false;
  }

  /**
   * Create a new LocalBeatChain from a seed string.
   * The genesis beat is deterministic from seed + domainPrefix.
   *
   * @param {object} opts
   *   @param {string} opts.seed            Unique identifier for this chain (e.g. agent hash)
   *   @param {number} [opts.difficulty=1000]  Hash iterations per beat
   *   @param {string} [opts.domainPrefix]  Genesis domain prefix (default: 'beats:genesis:v1:')
   *   @param {number} [opts.anchorIndex=0] Initial global anchor index
   *   @param {string} [opts.anchorHash]    Initial anchor hash to weave in
   *   @param {number} [opts.maxHistory=500] Max beats to keep in memory
   */
  static async create({
    seed,
    difficulty = 1000,
    domainPrefix = 'beats:genesis:v1:',
    anchorIndex = 0,
    anchorHash = null,
    maxHistory = 500,
  } = {}) {
    if (!seed || typeof seed !== 'string') {
      throw new Error('LocalBeatChain.create: seed must be a non-empty string');
    }
    const genesis = await createGenesisBeat(seed, domainPrefix);
    return new LocalBeatChain(genesis, { seed, difficulty, domainPrefix, anchorIndex, anchorHash, maxHistory });
  }

  /**
   * Restore a LocalBeatChain from a persisted state object.
   * Pass the result of JSON.parse(chain.persist()).
   *
   * @param {object} state  Previously persisted state
   */
  static async restore(state) {
    if (!state || !state.seed || !state.genesis || !state.head) {
      throw new Error('LocalBeatChain.restore: invalid state — must include seed, genesis, and head');
    }
    const chain = new LocalBeatChain(state.genesis, {
      seed: state.seed,
      difficulty: state.difficulty ?? 1000,
      domainPrefix: state.domainPrefix ?? 'beats:genesis:v1:',
      anchorIndex: state.anchorIndex ?? 0,
      anchorHash: state.anchorHash ?? null,
      maxHistory: state.maxHistory ?? 500,
    });
    chain.#head = { ...state.head };
    chain.#beatCount = state.beatCount ?? 0;
    chain.#history = Array.isArray(state.history)
      ? state.history.map(b => ({ ...b }))
      : [{ ...state.head }];
    return chain;
  }

  /**
   * Compute and append the next beat to the chain.
   * Weaves in the current anchor hash if set.
   *
   * @returns {Promise<{ index, hash, prev, anchor_hash }>}
   */
  async advance() {
    const nextIndex = this.#head.index + 1;
    const beat = await computeBeat(
      this.#head.hash,
      nextIndex,
      this.#difficulty,
      undefined,
      this.#anchorHash ?? undefined,
    );
    const entry = {
      index: beat.index,
      hash: beat.hash,
      prev: beat.prev,
      anchor_hash: beat.anchor_hash ?? null,
    };
    this.#head = { ...entry };
    this.#history.push(entry);
    this.#beatCount++;
    if (this.#history.length > this.#maxHistory) {
      this.#history = this.#history.slice(this.#history.length - this.#maxHistory);
    }
    return { ...this.#head };
  }

  /**
   * Build a WorkProofRequest from the current history window.
   *
   * The genesis beat (index 0) is never included in spot_checks because it
   * uses a different hash formula than compute beats (1, 2, 3...).
   *
   * @param {number} [lo]              Min beat index to include (inclusive)
   * @param {number} [hi]              Max beat index to include (inclusive)
   * @param {number} [spotCheckCount=5] Number of spot checks to sample
   * @returns {WorkProofRequest}
   */
  getProof(lo, hi, spotCheckCount = 5) {
    // Skip genesis beat — it uses a different formula and cannot be server-verified
    const genesisIndex = this.#genesis.index;
    const workBeats = this.#history.filter(b => {
      if (b.index === genesisIndex) return false;
      if (lo !== undefined && b.index < lo) return false;
      if (hi !== undefined && b.index > hi) return false;
      return true;
    });

    if (workBeats.length === 0) {
      throw new Error('LocalBeatChain.getProof: no work beats in history — call advance() first');
    }

    const first = workBeats[0];
    const last = workBeats[workBeats.length - 1];
    const count = Math.max(1, Math.min(spotCheckCount, workBeats.length));

    const sampled = sampleEvenly(workBeats, count);
    const seen = new Set();
    const spot_checks = [];
    for (const b of sampled) {
      if (!seen.has(b.index)) {
        seen.add(b.index);
        spot_checks.push({ index: b.index, hash: b.hash, prev: b.prev });
      }
    }

    const proof = {
      from_hash: first.prev,
      to_hash: last.hash,
      beats_computed: last.index - first.index + 1,
      difficulty: this.#difficulty,
      anchor_index: this.#anchorIndex,
      spot_checks,
    };
    if (this.#anchorHash) proof.anchor_hash = this.#anchorHash;
    return proof;
  }

  /**
   * Detect gap between current anchor and a newer global anchor.
   *
   * @param {number} currentAnchorIndex  Latest global anchor index from Beats service
   * @returns {{ gap_anchors, gap_beats_needed, last_anchor_index }}
   */
  detectGap(currentAnchorIndex) {
    const gap_anchors = Math.max(0, currentAnchorIndex - this.#anchorIndex);
    const gap_beats_needed = Math.min(gap_anchors * BEATS_PER_ANCHOR, MAX_RESYNC_BEATS);
    return { gap_anchors, gap_beats_needed, last_anchor_index: this.#anchorIndex };
  }

  /**
   * Compute catch-up beats after a gap (Re-Sync Challenge, D-72).
   *
   * Computes min(gap_anchors * BEATS_PER_ANCHOR, MAX_RESYNC_BEATS) beats
   * using the new anchor hash.
   *
   * @param {number} anchorIndex  New global anchor index
   * @param {string} [anchorHash] New anchor hash to weave in
   * @returns {Promise<number>}   Number of beats computed
   */
  async computeCatchup(anchorIndex, anchorHash = null) {
    const { gap_beats_needed } = this.detectGap(anchorIndex);
    this.#anchorIndex = anchorIndex;
    this.#anchorHash = anchorHash;
    for (let i = 0; i < gap_beats_needed; i++) {
      await this.advance();
    }
    return gap_beats_needed;
  }

  /**
   * Update the anchor reference without computing catch-up beats.
   * Use this when you want to start weaving a new anchor immediately.
   *
   * @param {number} anchorIndex  Global anchor index
   * @param {string} [anchorHash] Anchor hash to weave into future beats
   */
  setAnchorIndex(anchorIndex, anchorHash = null) {
    if (!Number.isInteger(anchorIndex) || anchorIndex < 0) {
      throw new Error('LocalBeatChain.setAnchorIndex: anchorIndex must be a non-negative integer');
    }
    this.#anchorIndex = anchorIndex;
    this.#anchorHash = anchorHash;
  }

  /**
   * Trim history to the most recent N beats.
   * Useful for long-running agents to bound memory usage.
   *
   * @param {number} [keepLast=100]  Number of recent beats to retain
   */
  clearHistory(keepLast = 100) {
    if (this.#history.length > keepLast) {
      this.#history = this.#history.slice(this.#history.length - keepLast);
    }
  }

  /**
   * Serialize chain state to a JSON string for persistence.
   * Restore with: LocalBeatChain.restore(JSON.parse(chain.persist()))
   */
  persist() {
    const state = this.getState();
    state.history = this.#history.map(b => ({ ...b }));
    return JSON.stringify(state);
  }

  /**
   * Get current chain state (without full history).
   * Use persist() to include history for restore.
   */
  getState() {
    return {
      seed: this.#seed,
      difficulty: this.#difficulty,
      domainPrefix: this.#domainPrefix,
      genesis: { ...this.#genesis },
      head: { ...this.#head },
      beatCount: this.#beatCount,
      anchorIndex: this.#anchorIndex,
      anchorHash: this.#anchorHash,
      maxHistory: this.#maxHistory,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Start auto-advancing the chain on a timer.
   *
   * @param {object} opts
   *   @param {number} [opts.intervalMs=1000]  Milliseconds between advances
   *   @param {function} [opts.onAdvance]      Called with (beat, state) after each advance
   *   @param {function} [opts.onError]        Called with (err) on advance failure
   */
  startAutoAdvance({ intervalMs = 1000, onAdvance = null, onError = null } = {}) {
    this.stopAutoAdvance();
    this.#autoRunning = true;
    const tick = async () => {
      if (!this.#autoRunning) return;
      try {
        const beat = await this.advance();
        if (typeof onAdvance === 'function') onAdvance(beat, this.getState());
      } catch (err) {
        if (typeof onError === 'function') onError(err);
      }
      if (this.#autoRunning) {
        this.#autoHandle = setTimeout(tick, intervalMs);
      }
    };
    this.#autoHandle = setTimeout(tick, intervalMs);
  }

  /** Stop auto-advancing. */
  stopAutoAdvance() {
    this.#autoRunning = false;
    if (this.#autoHandle !== null) {
      clearTimeout(this.#autoHandle);
      this.#autoHandle = null;
    }
  }

  // ---- Read-only getters ----
  get head() { return { ...this.#head }; }
  get genesis() { return { ...this.#genesis }; }
  get beatCount() { return this.#beatCount; }
  get difficulty() { return this.#difficulty; }
  get anchorIndex() { return this.#anchorIndex; }
  get anchorHash() { return this.#anchorHash; }
  get seed() { return this.#seed; }
  get domainPrefix() { return this.#domainPrefix; }
  get historyLength() { return this.#history.length; }
}

// ============ STANDALONE COMPUTE (Node.js only) ============

/**
 * Compute a single beat — sequential SHA-256 hash chain.
 *
 * Each beat requires `difficulty` sequential hash iterations.
 * Because SHA-256 output feeds the next input, this cannot be
 * parallelized. This is the CPU-work primitive for local beat chains.
 *
 * Node.js only: uses node:crypto. Not available in browser environments.
 *
 * @param {string}  prevHash    Previous beat hash (64 hex)
 * @param {number}  beatIndex   Beat index (monotonically increasing)
 * @param {number}  [difficulty=1000]  Hash iterations per beat
 * @param {string}  [nonce]     Optional entropy
 * @param {string}  [anchorHash]  Global anchor hash to weave in
 * @returns {{ index, hash, prev, timestamp, nonce?, anchor_hash? }}
 */
export async function computeBeat(prevHash, beatIndex, difficulty = 1000, nonce, anchorHash) {
  if (typeof prevHash !== 'string' || prevHash.length === 0) {
    throw new Error('computeBeat: prevHash must be a non-empty string');
  }
  if (!Number.isInteger(beatIndex) || beatIndex < 0) {
    throw new Error('computeBeat: beatIndex must be a non-negative integer');
  }
  const d = Math.max(1, Math.min(Number.isFinite(difficulty) ? Math.floor(difficulty) : 1000, 1_000_000));

  const { createHash } = await import('node:crypto');

  const seed = anchorHash
    ? `${prevHash}:${beatIndex}:${nonce || ''}:${anchorHash}`
    : `${prevHash}:${beatIndex}:${nonce || ''}`;

  let current = createHash('sha256').update(seed, 'utf8').digest('hex');
  for (let i = 0; i < d; i++) {
    current = createHash('sha256').update(current, 'utf8').digest('hex');
  }

  return {
    index: beatIndex,
    hash: current,
    prev: prevHash,
    timestamp: Date.now(),
    nonce,
    anchor_hash: anchorHash,
  };
}

/**
 * Compute the genesis beat for a local chain.
 * Deterministic from caller-provided seed + optional domain prefix.
 *
 * Node.js only.
 *
 * @param {string} seed          Unique identifier for this chain (e.g. agent hash)
 * @param {string} [domainPrefix='beats:genesis:v1:']  Namespace prefix
 */
export async function createGenesisBeat(seed, domainPrefix = 'beats:genesis:v1:') {
  if (!seed || typeof seed !== 'string') {
    throw new Error('createGenesisBeat: seed must be a non-empty string');
  }
  const { createHash } = await import('node:crypto');
  const genesisHash = createHash('sha256')
    .update(`${domainPrefix}${seed}`, 'utf8')
    .digest('hex');
  return {
    index: 0,
    hash: genesisHash,
    prev: '0'.repeat(64),
    timestamp: Date.now(),
  };
}
