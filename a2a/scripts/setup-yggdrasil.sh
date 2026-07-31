#!/usr/bin/env bash
# ADR-0006 workstream P2 (overlay network): installs and configures Yggdrasil on this node, so it
# gets a public-key-derived IPv6 address (200::/7) reachable via Yggdrasil's self-routing mesh -- no
# DNS, no NAT traversal needed between two Yggdrasil-connected nodes. This is the transport MOYE's
# did:moye: identity layer can eventually sit on top of (DID = stable name, Yggdrasil IPv6 = its
# transport projection), per ADR-0006 section H/I/J.
#
# STATUS (2026-07-25): real, verified, not scaffolding. Deployed and tested on all 3 production
# nodes (seed1/node2/node3): real public-Yggdrasil-peer connections (RTT + bytes transferred, not
# just a config file), real ping6 reachability between all three, and the MOYE API itself reachable
# cross-node purely over Yggdrasil (see the firewall step at the end -- that's ADR-0006 workstream
# I1's "clearnet service reachable from the overlay" direction, done). The previous version of this
# script pointed at a curl-pipe install URL that 404s; replaced with the official signed .deb release.
#
# NOT done, on purpose, in this script: the OTHER gateway direction (an overlay-only agent reaching
# arbitrary clearnet sites, i.e. a general-purpose forward proxy) -- that's a real open-relay/abuse
# surface (ADR-0006 workstream I2 explicitly calls for governance-gated abuse prevention before
# building it), and standing one up without that design would be introducing a real liability into
# production. Not attempted here.
#
# Usage: sudo ./scripts/setup-yggdrasil.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[setup-yggdrasil] must run as root (installs a system package + systemd service)"
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) DEB_ARCH="amd64" ;;
  aarch64) DEB_ARCH="arm64" ;;
  *) echo "[setup-yggdrasil] unrecognized architecture $ARCH -- see https://github.com/yggdrasil-network/yggdrasil-go/releases for the right asset name and adjust this script"; exit 1 ;;
esac

echo "[setup-yggdrasil] downloading the official signed release (v0.5.14, $DEB_ARCH)..."
if command -v apt-get >/dev/null; then
  TMP_DEB="$(mktemp --suffix=.deb)"
  curl -fsSL -o "$TMP_DEB" "https://github.com/yggdrasil-network/yggdrasil-go/releases/download/v0.5.14/yggdrasil-0.5.14-${DEB_ARCH}.deb"
  apt-get install -y "$TMP_DEB"
  rm -f "$TMP_DEB"
else
  echo "[setup-yggdrasil] no scripted install path for this distro yet -- see https://yggdrasil-network.github.io/installation.html"
  exit 1
fi
# The .deb's postinst already generates /etc/yggdrasil/yggdrasil.conf and enables the systemd unit.

echo ""
echo "[setup-yggdrasil] IMPORTANT: the generated config has an EMPTY Peers list -- you must add at"
echo "  least 2-3 real, currently-online public peers or this node won't actually join the network."
echo "  Pick ones geographically close to you from the live status page:"
echo "    https://publicpeers.neilalexander.dev/"
echo "  (the raw JSON at https://publicpeers.neilalexander.dev/publicnodes.json shows live up/down"
echo "  status + response times -- prefer low response_ms entries with \"up\": true)"
echo "  Edit /etc/yggdrasil/yggdrasil.conf's \"Peers: []\" line to something like:"
echo '    Peers: ['
echo '      tcp://some-peer-host:port'
echo '      tcp://another-peer-host:port'
echo '    ]'
echo "  Then: yggdrasil -useconffile /etc/yggdrasil/yggdrasil.conf -normaliseconf > /dev/null && echo config OK"
echo ""

systemctl enable --now yggdrasil
sleep 2

echo "[setup-yggdrasil] this node's overlay identity:"
yggdrasilctl getSelf || echo "[setup-yggdrasil] yggdrasilctl getSelf failed -- check systemctl status yggdrasil"

echo ""
echo "[setup-yggdrasil] after adding peers and restarting (systemctl restart yggdrasil), verify with:"
echo "  yggdrasilctl getPeers    # should show your configured peers with State: Up"
echo "  ping6 <another Yggdrasil node's address>   # real reachability test"
echo ""
echo "[setup-yggdrasil] next: wire this node's overlay address into moye-a2a by adding"
echo "  Environment=OVERLAY_ADDR=<the IPv6 address from getSelf above>"
echo "  to /etc/systemd/system/moye-a2a.service, then systemctl daemon-reload && systemctl restart moye-a2a"
echo "  -- it'll then show up in GET /.well-known/moye-net."
echo ""
echo "[setup-yggdrasil] optional: expose moye-a2a's own API to other Yggdrasil peers directly (no"
echo "  clearnet/DNS route needed at all) -- ADR-0006 workstream I1's 'clearnet service reachable"
echo "  from the overlay' direction. Node.js's default listen() already binds all interfaces"
echo "  including tun0, so this is a firewall-only change, scoped to the yggdrasil interface (NOT"
echo "  opening the port to the whole internet):"
echo '    ufw allow in on tun0 to any port 3100 proto tcp comment "yggdrasil-to-moye-api"'
echo "  Verify from another Yggdrasil-connected node: curl -6 http://[<this node's overlay addr>]:3100/health"
