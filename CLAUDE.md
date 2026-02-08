# Provenonce Beats — Stateless Time Verification Service

> The global heartbeat of the Provenonce network.

## Project Overview

Beats is the stateless time verification layer for Provenonce. It has **zero database** — all state is read from and written to Solana as SPL Memo transactions. It serves two purposes:

1. **Verify** VDF proofs submitted by agents (pure math, no state needed)
2. **Anchor** the global beat chain by periodically writing a new anchor memo to Solana

This service is intentionally minimal. It can be replaced, scaled, or forked without affecting agent state. The Registry service (separate repo) handles identity, accountability, and agent lifecycle.

## Repo Layout

Registry and Beats are **separate repos with no shared remotes**:

| Service | Local Path | GitHub | Vercel |
|---------|-----------|--------|--------|
| Beats (this repo) | `/c/provenonce-beats` | `jarekpiot/provenonce-beats` | `beats-jet.vercel.app` |
| Registry | `/c/provenance-app2` | `jarekpiot/provenonce` | `provenance-app2.vercel.app` |

**Rules:**
- Always `cd` and `pwd` before any git operation. State which service you're modifying.
- Beats changes: `cd /c/provenonce-beats`
- Registry changes: `cd /c/provenance-app2`
- NEVER push to the wrong repo.
- `lib/beat.ts` is duplicated in both repos — must sync manually on VDF changes.

## Architecture

```
Beats Service (this repo)
├── /api/v1/beat/verify  — Stateless VDF proof verification (POST)
├── /api/v1/beat/anchor  — Read latest anchor from Solana (GET)
├── /api/cron/anchor     — Advance anchor chain, write to Solana (GET, CRON_SECRET)
├── /api/health          — Liveness check (GET)
└── lib/
    ├── beat.ts          — Pure VDF engine (zero imports, shared with Registry)
    ├── solana.ts        — Solana RPC, memo read/write, keypair management
    └── rate-limit.ts    — IP-based rate limiting
```

**Key constraint**: No Supabase, no database, no agent state. If you find yourself wanting to add a database, you're probably building a Registry feature instead.

## Key Files

| File | Purpose |
|------|---------|
| `lib/beat.ts` | VDF engine — `computeBeat()`, `verifyGlobalAnchor()`, `createGlobalAnchor()`, `verifyCheckinProof()`. Identical to Registry's copy. **Must stay in sync.** |
| `lib/solana.ts` | Solana integration — `getLatestAnchorFromSolana()`, `writeAnchorMemo()`, `getAnchorKeypair()`. Reads/writes SPL Memo transactions. |
| `lib/rate-limit.ts` | In-memory rate limiter. Verify: 10/min, Anchor read: 30/min. |
| `app/api/v1/beat/verify/route.ts` | Accepts a `BeatProof`, runs `verifyCheckinProof()`, returns pass/fail. No auth required. |
| `app/api/v1/beat/anchor/route.ts` | Reads the latest global anchor from Solana memos. Returns anchor data + on-chain tx signature. |
| `app/api/cron/anchor/route.ts` | Cron endpoint (every minute, Vercel Pro). Creates next global anchor, writes memo to Solana. Protected by `CRON_SECRET`. |
| `app/api/health/route.ts` | Returns `{ ok: true }`. Used by monitoring. |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `BEATS_ANCHOR_KEYPAIR` | Yes | Base58-encoded Solana keypair for writing anchor memos |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | No | Solana RPC URL (defaults to devnet) |
| `CRON_SECRET` | Yes | Protects `/api/cron/anchor` from unauthorized calls |

## How It Works

### Verify Flow
1. Agent computes VDF beats locally using `computeBeat()`
2. Agent sends proof to Registry via SDK `checkin()`
3. Registry can optionally forward proof to Beats `/verify` for independent verification
4. Beats runs `verifyCheckinProof()` — pure math, no state lookup needed
5. Returns `{ valid: true/false }`

### Anchor Flow
1. Vercel cron triggers `GET /api/cron/anchor` every minute
2. Reads the latest anchor memo from Solana
3. Computes the next anchor using `createGlobalAnchor()`
4. Writes the new anchor as an SPL Memo transaction
5. Registry reads the new anchor via `GET /api/v1/beat/anchor`

### Solana Memo Format
Anchors are stored as JSON memo text on Solana transactions:
```json
{
  "type": "beat_anchor",
  "beat_index": 42,
  "hash": "abc123...",
  "prev_hash": "def456...",
  "utc": 1707307200000,
  "difficulty": 1000,
  "epoch": 0
}
```

## Conventions

- **Zero database**: All state comes from Solana. No Supabase.
- **Pure math**: `lib/beat.ts` has no project imports — only Node.js built-in `crypto`.
- **Naming**: Same conventions as Registry (see Registry CLAUDE.md).
- **Commit style**: Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

## Known Issues

| Issue | Notes |
|-------|-------|
| `lib/beat.ts` must stay in sync | This file is duplicated from the Registry. Any VDF changes must be applied to both. Consider publishing as a shared npm package. |
| In-memory rate limiting | Resets on each Vercel cold start. Acceptable for current scale. |
| No custom domain | Using default `beats-jet.vercel.app`. Custom domain deferred. |

## Contacts

- **Genesis**: Jarek Piotrowski — founder, primary developer
- **Co-founder**: Jon Teo — strategic direction
