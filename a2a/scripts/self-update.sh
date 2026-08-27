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

# --- Ops decision 2026-08-26: stop Yggdrasil on every node. It peers with the public Yggdrasil
# network by design (scripts/setup-yggdrasil.sh), and GET /api/network publishes each node's
# overlay_addr under the moye.ai domain -- combined, anyone who peers with a node can map its
# published overlay address back to the node's real IP. Applied here (not by hand per box) so it
# lands uniformly on the same pull cycle as everything else. Idempotent; no-ops where yggdrasil was
# never installed. See DEPLOY.md 四-D.
if systemctl list-unit-files yggdrasil.service >/dev/null 2>&1; then
  if systemctl is-active --quiet yggdrasil 2>/dev/null || systemctl is-enabled --quiet yggdrasil 2>/dev/null; then
    echo "[self-update] stopping+disabling yggdrasil"
    systemctl disable --now yggdrasil 2>/dev/null || sudo systemctl disable --now yggdrasil 2>/dev/null || true
  fi
fi

# --- Ops decision 2026-08-26: stop advertising OVERLAY_ADDR now that Yggdrasil is off above --
# otherwise GET /api/network keeps showing a dead-but-still-moye.ai-linked overlay address
# indefinitely, which defeats half the point of stopping the daemon. A later-loaded drop-in's
# `Environment=` overrides a same-named `Environment=` from the main unit file (systemd.exec(5):
# last assignment for a given variable wins), so this doesn't require touching moye-a2a.service
# itself -- runs on all three nodes unconditionally, same best-effort/non-aborting write pattern as
# the p2p drop-in below.
OVERLAY_DROPIN_DIR=/etc/systemd/system/moye-a2a.service.d
OVERLAY_DROPIN_FILE="$OVERLAY_DROPIN_DIR/20-clear-overlay-addr.conf"
( mkdir -p "$OVERLAY_DROPIN_DIR" && printf '[Service]\nEnvironment="OVERLAY_ADDR="\n' > "$OVERLAY_DROPIN_FILE" ) 2>/dev/null \
  || ( sudo mkdir -p "$OVERLAY_DROPIN_DIR" && printf '[Service]\nEnvironment="OVERLAY_ADDR="\n' | sudo tee "$OVERLAY_DROPIN_FILE" >/dev/null ) 2>/dev/null \
  || echo "[self-update] WARNING: could not write $OVERLAY_DROPIN_FILE (insufficient privilege?) -- overlay_addr still advertised this cycle"
systemctl daemon-reload 2>/dev/null || sudo systemctl daemon-reload 2>/dev/null || true

# --- Ops decision 2026-08-26: enable the libp2p relay (ENABLE_P2P) on node2/node3, using the same
# Cloudflare-Tunnel-fronted pattern seed1 already runs (P2P_PUBLIC_HOSTNAME, never a raw port/IP --
# see the P2P_PUBLIC_HOSTNAME comment in lib/p2p_relay.js). Reads NODE_ID from this node's own
# moye-a2a.service unit rather than needing a new env var passed into this script. The matching
# Cloudflare Tunnel Public Hostname (p2p-node2.moye.ai / p2p-node3.moye.ai -> localhost:4100, WS)
# still has to be added by the domain holder in the Cloudflare dashboard -- same division of labor as
# every other Tunnel hostname in this project (DEPLOY.md 四-E); this script can't reach that account.
NODE_ID_ON_DISK="$(grep -oP 'Environment=NODE_ID=\K\S+' /etc/systemd/system/moye-a2a.service 2>/dev/null || true)"
P2P_HOSTNAME=""
case "${NODE_ID_ON_DISK:-}" in
  node2) P2P_HOSTNAME="p2p-node2.moye.ai" ;;
  node3) P2P_HOSTNAME="p2p-node3.moye.ai" ;;
esac
if [ -n "$P2P_HOSTNAME" ]; then
  DROPIN_DIR=/etc/systemd/system/moye-a2a.service.d
  DROPIN_FILE="$DROPIN_DIR/10-p2p-relay.conf"
  DROPIN_CONTENT="$(printf '[Service]\nEnvironment="ENABLE_P2P=1"\nEnvironment="P2P_PUBLIC_HOSTNAME=%s"\n' "$P2P_HOSTNAME")"
  # Every step here is best-effort (`|| true`): this whole block is a convenience so ops doesn't
  # have to log in and hand-edit a unit file, NOT allowed to ever abort the script under `set -e` --
  # a permission failure here must never block the git update / npm install / restart below it.
  ( mkdir -p "$DROPIN_DIR" && printf '%s' "$DROPIN_CONTENT" > "$DROPIN_FILE" ) 2>/dev/null \
    || ( sudo mkdir -p "$DROPIN_DIR" && printf '%s' "$DROPIN_CONTENT" | sudo tee "$DROPIN_FILE" >/dev/null ) 2>/dev/null \
    || echo "[self-update] WARNING: could not write $DROPIN_FILE (insufficient privilege?) -- ENABLE_P2P not applied this cycle"
  systemctl daemon-reload 2>/dev/null || sudo systemctl daemon-reload 2>/dev/null || true
  echo "[self-update] node ${NODE_ID_ON_DISK}: applied ENABLE_P2P=1, P2P_PUBLIC_HOSTNAME=${P2P_HOSTNAME}"
fi

cd a2a
npm install --omit=dev
sudo systemctl restart moye-a2a 2>/dev/null || systemctl restart moye-a2a
sleep 3
curl -sf "http://localhost:${PORT:-3100}/health" && echo "" && echo "[self-update] healthy"
