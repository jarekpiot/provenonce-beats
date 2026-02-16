# Provenonce Beats

Stateless time/anchor service for Provenonce.

## Purpose

`provenonce-beats` does two things:

1. Publish global anchors to Solana via SPL Memo (`/api/cron/anchor`)
2. Expose public beat/proof verification (`/api/v1/beat/verify`)

No database, no identity state, no wallet custody for agents.

## Canonical Endpoints

- `GET /api/v1/beat/anchor` - latest canonical anchor + tx link
- `POST /api/v1/beat/verify` - strict beat/chain/proof verification
- `GET /api/cron/anchor` - cron anchor advance (requires `CRON_SECRET`)
- `GET /api/health` - service liveness

## Environment

- `BEATS_ANCHOR_KEYPAIR` (required)
- `CRON_SECRET` (required in production)
- `NEXT_PUBLIC_SOLANA_RPC_URL` (optional; defaults devnet)

## Security/Behavior Notes

- Cron fails closed when `CRON_SECRET` is unset.
- Solana send/read paths use finalized confirmation discipline.
- Canonical anchor selection is deterministic and continuity-aware.
- Public verify route has explicit cost guards and rate limits.

## Repo Mapping

- Beats repo: `jarekpiot/provenonce-beats`
- Registry repo: `jarekpiot/provenonce`
- Docs site repo: `jarekpiot/provenonce-dev`

## Anchor Memo Shape

```json
{
  "v": 1,
  "type": "anchor",
  "beat_index": 10423,
  "hash": "f7d5...",
  "prev": "86c4...",
  "utc": 1771282459742,
  "difficulty": 1000,
  "epoch": 0
}
```
