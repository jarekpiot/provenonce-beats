# Academic Technical Security Review: `provenonce-beats`

Date: 2026-02-15
Scope: the Beats service (`provenonce-beats`) as deployed on `https://beats.provenonce.dev`, including its VDF construction, verification endpoints, and Solana anchor read/write logic.

This document is intended to withstand skeptical third‑party review. It separates:
- **Security properties** (what the service claims to guarantee),
- **Evidence** (code + tests/probes),
- **Residual risks** (explicitly out of scope or not proven).

## 1) What Beats Is (System Model)

Beats is a stateless “time authentication” service built on:

1. A sequential SHA‑256 hash chain (“VDF-like” work function) with adjustable difficulty (`lib/beat.ts`).
2. A global anchor chain published on Solana memos by a single anchor key (`lib/solana.ts`, `app/api/cron/anchor/route.ts`).
3. Public verification utilities (`app/api/v1/beat/verify/route.ts`) that recompute work for:
   - single beats,
   - beat chains (spot checks + linkage),
   - checkin proofs (spot checks).

Beats does **not** maintain per-agent state and does not itself decide “who is legitimate”. It provides:
- a canonical *clock* (anchors),
- a public *verifier* (recompute/spot-check).

The registry (`provenonce`) is the stateful component that binds proofs to an agent’s stored latest beat and enforces economic policy.

## 2) Threat Model

Assume:
- Untrusted clients can call public endpoints at high rate and send adversarial bodies/headers.
- Attackers can retry verification requests (adaptive to randomness).
- Attackers may use specialized hardware (GPU/ASIC) to compute hashes faster.
- Solana RPC may be delayed, rate limited, or temporarily unavailable.
- **Key compromise** is the catastrophic case: if `BEATS_ANCHOR_KEYPAIR` is stolen, an attacker can publish arbitrary anchors.

Non-goals (for this service as currently designed):
- Providing succinct verification (i.e., a true cryptographic VDF proof with cheap verification).
- Distributed/global rate limiting (the limiter is in-memory).

## 3) Claims and Intended Security Properties

### C1) Sequential-work “beat” cost is unskippable (within the hash‑chain model)

**Implementation:** `computeBeat()` hashes a seed then hashes the result `difficulty` times (`lib/beat.ts`).

**Claim:** Producing a valid beat hash requires performing the sequential work; it cannot be parallelized across the inner loop because each hash depends on the previous output.

**Reviewer nuance:** This is *sequential* under the standard assumption that SHA‑256 is a random oracle-like compression function and that there is no shortcut to compute the iterated function faster than performing it. However:
- Hardware asymmetry (ASICs) can reduce cost per hash dramatically.
- This construction is not a formally proven VDF in the Wesolowski/Pietrzak sense; verification is not succinct.

### C2) Public verification is sound for the object it verifies

**Implementation:** `verifyBeat()` recomputes `computeBeat()` and compares hashes (`lib/beat.ts`). `POST /api/v1/beat/verify` calls `verifyBeat`, `verifyBeatChain`, `verifyCheckinProof` (`app/api/v1/beat/verify/route.ts`).

**Claim:** If `verifyBeat` returns valid, the beat hash matches a recomputation under the supplied `difficulty` and included fields (`prev`, `index`, optional `nonce`, optional `anchor_hash`).

This is a strong claim for a single beat. For *chains/proofs*, see the caveats in Section 5 (spot-check soundness and binding to an agent’s chain).

### C3) Canonical anchor head selection is deterministic and continuity-aware

**Implementation:** `readLatestAnchor()` scans recent memos and calls `selectCanonicalAnchor()` (`lib/solana.ts`, `lib/anchor-canonical.js`).

**Claim:** Among observed candidate anchors, Beats selects a canonical tip deterministically using:
- highest `beat_index`,
- then deepest linked chain available in the candidate set,
- then lexicographic `hash` tie-break.

This prevents “max-index only” selection, *assuming the candidate set includes a linkable chain* (see caveat R1 below).

### C4) Anchor publication is bounded by platform cron and uses Solana as the persistence layer

**Implementation:** `GET /api/cron/anchor` reads the latest on-chain anchor, checks freshness by UTC age, and writes the next anchor as a Solana memo signed by `BEATS_ANCHOR_KEYPAIR` (`app/api/cron/anchor/route.ts`, `lib/solana.ts`, `lib/beat.ts`).

**Claim:** Anchors form an append-only on-chain sequence under a single signing key (the anchor wallet).

## 4) Evidence Review (What We Can Point To)

### CI / reproducibility (canonical)

- GitHub Actions (Ubuntu) workflow: `.github/workflows/ci.yml`
  - Runs: `npm ci`, `npm run build`, `node --test`
  - Reviewer note: use the Actions run for the relevant commit as the canonical “no Windows EPERM flakiness” evidence.

### VDF / beat engine evidence

- Sequential hashing core:
  - `lib/beat.ts`: `computeBeat`, `verifyBeat`, constants for `MIN_DIFFICULTY`/`MAX_DIFFICULTY`.
- Global anchor generation and verification:
  - `lib/beat.ts`: `createGlobalAnchor`, `verifyGlobalAnchor`.

### Anchor parsing and fork choice evidence

- Strict memo parsing and canonical selection:
  - `lib/anchor-canonical.js`: `parseAnchorMemo`, `selectCanonicalAnchor`.

### Public verification endpoint evidence

- `app/api/v1/beat/verify/route.ts`: mode dispatch (`beat`/`chain`/`proof`), difficulty clamping, and rate limiting (`10/min/IP`).

### Operational anchor issuance evidence

- `app/api/cron/anchor/route.ts`: cron auth via `CRON_SECRET` (when set), staleness logic, memo write path.

## 5) Critical Analysis (Where Scrutiny Will Focus)

This is the section a serious reviewer will care about: not whether code “runs”, but whether its claims are *well-defined* and *correct under adversarial use*.

### 5.1 The construction is “VDF-like”, but not a cryptographic VDF with succinct verification

What it is:
- An iterated hash chain: `H^k(seed)` for k≈difficulty (plus a seed hash).

What it is not:
- A VDF with a *succinct* proof and fast verification.

Implication:
- Verification cost is proportional to `difficulty` per verified beat.
- To keep verification practical, the system uses spot checks (probabilistic assurance).

Academic wording recommendation:
- Avoid claiming “VDF” in the strict cryptographic sense. Use “sequential-work hash chain” or “VDF-like sequential delay function” unless you formally define the security model you rely on.

### 5.2 Spot-check verification is probabilistic and (as a public endpoint) is vulnerable to adaptive retries

`verifyBeatChain()` uses `Math.random()` to select spot checks (`lib/beat.ts`). A client can:
- submit a chain,
- if it fails, retry until the verifier’s randomness happens to sample only the beats the client computed honestly.

This is acceptable as a “utility endpoint”, but it is *not* a robust acceptance oracle unless:
- the verifier chooses randomness the prover cannot influence and cannot cheaply query repeatedly (e.g., a challenge/nonce or deterministic sampling derived from a server-chosen seed),
- and/or the registry has additional stateful binding checks.

### 5.3 Proof verification validates local work at sampled indices but does not, by itself, prove continuity from `from_hash` to `to_hash`

`verifyCheckinProof()` recomputes beats for each provided spot check using the spot check’s `prev` (and optional nonce) plus `proof.anchor_hash` (`lib/beat.ts`).

However:
- It does not use `proof.from_hash` / `proof.to_hash` as cryptographic commitments.
- It does not ensure that the provided spot check `prev` values are consistent with a single chain rooted at `from_hash`.

This is not automatically a vulnerability if the *registry* (stateful system) enforces:
- `from_hash` equals the agent’s stored latest beat hash,
- the window is anchored to a recent global anchor hash,
- and it uses the proof only as evidence of “some work done” plus correct endpoint.

But academically, you must be explicit:
- Beats’ `/beat/verify` in `proof` mode is a **stateless validator**, not a full “proof of continuous computation” unless additional binding is performed elsewhere.

### 5.4 Public verify route allows client-controlled workload (DoS surface)

In `POST /api/v1/beat/verify`:
- `difficulty` is clamped to `[MIN_DIFFICULTY, MAX_DIFFICULTY]` where `MAX_DIFFICULTY = 1,000,000`.
- `chain` mode permits up to `1000` beats and accepts `spot_checks` from the client without an explicit upper bound.

Risk:
- A single request can force very expensive recomputation if `difficulty` and/or `spot_checks` are high.
- Rate limiting is in-memory per instance; distributed attackers can bypass it.

Academic stance:
- This is a real residual risk for the public verifier surface. Either:
  - reduce public `MAX_DIFFICULTY` to a safe bound for serverless, and cap `spot_checks`, or
  - treat this endpoint as best-effort (and document that production needs a shared KV limiter / WAF).

### 5.5 Anchor continuity and fork choice are only as strong as key custody and RPC honesty

Anchors are written by a single Solana key (`BEATS_ANCHOR_KEYPAIR`). The strongest statement you can make is:
- If the anchor key is uncompromised, third parties can audit the anchor chain by scanning on-chain memos from that address.

Residual risks:
- If `BEATS_ANCHOR_KEYPAIR` is compromised, the attacker can publish an alternative anchor history. This is a “global clock compromise”.
- RPC can lie or be partitioned; mitigation is multi-RPC verification or client-side independent verification.

## 6) Does Beats Do What It Says?

Yes, under a precise reading:
- It provides a sequential-work hash chain primitive and a public recomputation-based verifier.
- It publishes a global anchor sequence to a public ledger and reads it back deterministically with continuity preference.
- It is intentionally stateless and does not claim to enforce agent identity; it only “authenticates time/work” for inputs.

Where you must be careful academically:
- Don’t claim that the public verifier’s spot-check modes provide a non-interactive, non-adaptive “proof of continuous computation” without clarifying the probabilistic nature and the need for stateful binding in the registry.
- Don’t claim “VDF” with cryptographic guarantees unless you define the model; this is a sequential hash chain with expensive verification.

## 7) Recommendations to Improve Academic Defensibility

These are not required for P0–P3 closure, but they materially improve reviewer confidence:

1. **Rename/define the primitive precisely.**
   - “Sequential-work hash chain” rather than “VDF” unless you add a formal definition section.
2. **Make sampling deterministic or challenge-based.**
   - For `chain` and `proof` verification, derive spot-check indices from a server-provided nonce or from a hash commitment so clients cannot adapt via retries.
3. **Bind proofs more tightly.**
   - If proofs include `from_hash`/`to_hash`, either:
     - enforce that the endpoint spot-check hash equals `to_hash`, and/or
     - include additional commitments (e.g., hash of the entire window) to prevent “free choice of prev” at checked indices.
4. **Cap public verification cost.**
   - Reduce effective public `MAX_DIFFICULTY` and cap `spot_checks`.
   - Consider separate “trusted/internal” verification paths if needed.
5. **Key custody hardening (maturity track).**
   - RFC-006 threshold signing and emergency rotation is the correct next step for the anchor key.

## 8) Conclusion

Beats will stand up to scrutiny **if its claims are scoped correctly**:
- As a sequential-work hash chain, it is straightforward and auditable.
- As a public verifier, it is correct for single-beat recomputation, and probabilistic for chain/proof modes.
- As a global anchor publisher, it provides an on-chain append-only clock under a single key, with deterministic canonical selection over observed candidates.

The main academic risks are over-claiming (“cryptographic VDF” / “continuous computation proof”) and under-specifying the adversarial retry and cost-amplification surfaces. Both are addressable by tightening definitions and capping verifier workload.
