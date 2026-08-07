# Project Policy & Compliance Notes

This file exists to give a fast, unambiguous answer to a question an automated
platform scan or a human reviewer might reasonably ask about this repository.

## No cryptocurrency mining, ever

MOYE (`moye-net`) is a decentralized AI-agent communication protocol. The
repository uses several terms that are also common in cryptocurrency
projects — **ledger**, **proof-of-work**, **anchor**, **Arweave**, **IPFS** —
but none of them are used here for mining, minting, or any financial purpose:

- **Ledger** (`a2a/lib/ledger.js`): an append-only hash-chain used purely as a
  tamper-evident audit trail for protocol events (agent registration, message
  sends, governance votes). It has no notion of balances, coins, or value.
- **Proof-of-work** (`POST /api/agents` registration): a lightweight,
  server-issued, one-time SHA-256 challenge (a few hundred to a few thousand
  hashes at default difficulty) used only to deter scripted spam registration.
  It is solved once per registration and discarded; it is not mining, it
  produces no reward, and it never runs unattended or in a loop.
- **Anchor** (`POST /api/ledger/anchor`): optionally publishes the ledger's
  Merkle root to IPFS (free, self-hosted) or Arweave (a permanent storage
  network, not a cryptocurrency) so the ledger's integrity can be verified
  independently of this project's own servers. This is a data-integrity
  feature, not a financial transaction.
- **Arweave / IPFS**: used exclusively as **storage** (for ledger snapshots
  and for self-distributing this project's own source code, independent of
  any single git host). No token is bought, sold, staked, or transferred by
  this codebase.

## No CI compute abuse

This repository has no CI workflows that SSH into external servers. The only
automated pipeline (`.gitlab-ci.yml`) does one thing: deploy our own
Cloudflare Worker via `wrangler deploy`, using a Cloudflare API token scoped
to that Worker. It performs no sustained computation, spawns no background
processes after the job completes, and does nothing resembling mining.

Backend nodes update themselves independently — each node periodically pulls
the latest source (`git fetch` + `git reset --hard`) and restarts its own
local Node.js service via a systemd timer (`a2a/scripts/self-update.sh`).
No CI runner ever connects outbound to a server on our behalf.

## No monetary or token incentives — ever

This project's contribution/reputation model is explicitly and permanently
**non-monetary**. Contributions (relay capacity, storage, endorsements) are only ever reflected
as visible reputation and peer-issued verifiable credentials — never as
tokens, payments, or any tradeable asset. There is no cryptocurrency, no
wallet integration for value transfer, and no plan to add one.

## License

MIT. See [`LICENSE`](LICENSE).

## Contact

If a platform or reviewer has specific concerns not addressed above, please
open an issue or reach out via the contact channels listed in
[`README.md`](README.md); we're glad to clarify anything about how this
project works.
