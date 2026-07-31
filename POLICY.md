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
  and, per ADR-0006, for self-distributing this project's own source code).
  No token is bought, sold, staked, or transferred by this codebase.

## No GitHub Actions compute abuse

The CI workflows in `.github/workflows/` do exactly two things:

1. **Deploy** — SSH into servers we own and run `git pull` + restart our own
   Node.js service, or run `wrangler deploy` for our own Cloudflare Worker.
2. **Test** — run a Playwright end-to-end test suite against a disposable
   local instance of our own server.

Neither workflow performs sustained computation, spawns background processes
after the job completes, or does anything resembling mining.

## No monetary or token incentives — ever

This project's contribution/reputation model (see
`a2a/docs/adr/0006-resilience-distribution-independence.md`, §0.5, a locally
maintained design document) is explicitly and permanently **non-monetary**.
Contributions (relay capacity, storage, endorsements) are only ever reflected
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
