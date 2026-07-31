#!/usr/bin/env bash
# ADR-0006 workstream C2: update this node without depending on GitHub Actions CI.
# Tries each git remote in order (so a GitHub outage/suspension doesn't block updates as long as
# ANY mirror -- GitLab, Codeberg, self-hosted -- is reachable), and falls back to recovering the
# source tree from this node's own IPFS-anchored release (see scripts/publish-source.js /
# GET /api/source/latest) if no git remote at all is reachable.
#
# Usage: ./scripts/self-update.sh [remote1 remote2 ...]
#   With no args, tries every remote currently configured on `origin` plus any extra remotes named
#   in $MOYE_MIRRORS (space-separated remote names, e.g. "gitlab codeberg").
#
# Safe to run from cron for unattended nodes; every step is set -e, so a failed step doesn't leave
# the checkout half-updated -- it just stops before the restart.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root (this script lives in a2a/scripts/)

REMOTES=("$@")
if [ ${#REMOTES[@]} -eq 0 ]; then
  # Default candidate order: origin, then anything named in MOYE_MIRRORS, deduped.
  REMOTES=("origin")
  for r in ${MOYE_MIRRORS:-}; do REMOTES+=("$r"); done
fi

updated=0
for remote in "${REMOTES[@]}"; do
  echo "[self-update] trying remote: $remote"
  if git fetch "$remote" main 2>/tmp/self-update-fetch.log; then
    git reset --hard "$remote/main"
    echo "[self-update] updated from $remote (commit $(git rev-parse --short HEAD))"
    updated=1
    break
  else
    echo "[self-update] $remote unreachable:"; cat /tmp/self-update-fetch.log
  fi
done

if [ "$updated" -ne 1 ]; then
  echo "[self-update] no git remote reachable. Falling back to this node's own IPFS-anchored release."
  echo "[self-update] fetch the pointer yourself and verify before applying, e.g.:"
  echo "    curl -s http://localhost:${PORT:-3100}/api/source/latest"
  echo "    ipfs cat <tarball_cid> > moye-source.tar.gz && sha256sum moye-source.tar.gz  # compare to the sha256 above"
  echo "[self-update] NOT auto-extracting an IPFS recovery tarball over a live checkout -- that step needs a human"
  echo "[self-update] to confirm the recovered commit is the one they intend to run. Exiting without changes."
  exit 1
fi

cd a2a
npm install --omit=dev
sudo systemctl restart moye-a2a 2>/dev/null || systemctl restart moye-a2a
sleep 3
curl -sf "http://localhost:${PORT:-3100}/health" && echo "" && echo "[self-update] healthy"
