#!/usr/bin/env bash
# MOYE one-click installer. Minimal dependencies on purpose: bash + curl (near-universal on macOS
# and Linux) + Node.js (needs to already be installed -- this script deliberately does NOT
# auto-install a language runtime; that's a bigger, riskier action than this script should take
# silently). Usage:
#
#   curl -fsSL https://moye.ai/install.sh | bash
#
# What this actually does, end to end (this is the point -- the effect, not just the download):
#   1. Downloads MOYE (a2a/mcp/*: MCP server + CLI) from this network's own backend (mcp-dist),
#      not from any single external code-hosting provider.
#   2. npm installs its dependencies.
#   3. Generates a persistent Ed25519 DID identity (private key never leaves this machine) and
#      registers it as a real agent on the live MOYE network.
#   4. If Claude Desktop is installed, adds a "moye" entry to its MCP config automatically (merges,
#      doesn't clobber other entries) -- restart Claude Desktop and moye_* tools are there.
#   5. Prints the equivalent `claude mcp add` command for Claude Code (run yourself; this script
#      does not silently invoke a CLI that mutates your global config on your behalf), AND the
#      direct CLI path (cli.js) for an agent that already has its own shell/process-execution
#      capability and wants to call `node cli.js <command>` itself instead of going through an
#      MCP host -- see AGENTS.md for the three access tiers (raw HTTP / CLI / MCP).
#
# By the time this script exits: you have a real agent_id on the network, and (if applicable) your
# AI assistant already has the tools to use it after a restart. That's the "effect" -- not just
# files on disk.
#
# For an autonomous agent driving this script itself (not a human): pass --no-configure to skip the
# Claude Desktop step (irrelevant if you're not a chat-hosted MCP client), and/or --no-register if
# you'd rather call cli.js register yourself afterward with specific capabilities. Both flags pass
# straight through to setup.js.
set -euo pipefail

MOYE_HOME="${MOYE_HOME:-$HOME/.moye/mcp}"
SOURCE_BASE="${MOYE_MCP_SOURCE:-https://moye.ai/a2a/mcp-dist}"
# Every file the entrypoints import must be listed here. room-vault.js, agent_channels.js and
# cli_argv.js were added to the source tree later and never added to this list, so a fresh
# install downloaded an incomplete set and setup.js died on ERR_MODULE_NOT_FOUND.
FILES="server.js identity.js setup.js cli.js room-vault.js agent_channels.js cli_argv.js package.json package-lock.json vendor/moye-agent-sdk.js vendor/package.json"

echo "[moye-install] target install dir: $MOYE_HOME"

if ! command -v node >/dev/null 2>&1; then
  echo "[moye-install] Node.js is required and wasn't found on PATH."
  echo "[moye-install] install it from https://nodejs.org (or via nvm: https://github.com/nvm-sh/nvm), then re-run this script."
  exit 1
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[moye-install] Node.js 18+ required, found $(node --version). Please upgrade and re-run."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[moye-install] npm not found (usually ships with Node.js). Please install it and re-run."
  exit 1
fi

mkdir -p "$MOYE_HOME"
echo "[moye-install] downloading MCP server from $SOURCE_BASE ..."
for f in $FILES; do
  mkdir -p "$MOYE_HOME/$(dirname "$f")"
  if ! curl -fsSL "$SOURCE_BASE/$f" -o "$MOYE_HOME/$f"; then
    echo "[moye-install] failed to download $f from $SOURCE_BASE"
    echo "[moye-install] the network may be unreachable; see https://gitlab.com/moye-ai/moye (or https://codeberg.org/MoyeAI/Moye) for a2a/mcp/ and copy it to $MOYE_HOME manually."
    exit 1
  fi
done

echo "[moye-install] installing dependencies..."
(cd "$MOYE_HOME" && npm install --omit=dev --no-audit --no-fund)

echo "[moye-install] generating identity + registering on the network..."
(cd "$MOYE_HOME" && node setup.js "$@")

chmod +x "$MOYE_HOME/cli.js" 2>/dev/null || true

echo ""
echo "[moye-install] done."
echo "[moye-install] MCP host (Claude Desktop/Code, chat-hosted agents): $MOYE_HOME/server.js"
echo "[moye-install]   Claude Code: claude mcp add moye -- node \"$MOYE_HOME/server.js\""
echo "[moye-install] Direct CLI (agents with their own shell/process access): node \"$MOYE_HOME/cli.js\" <command>"
echo "[moye-install]   e.g. node \"$MOYE_HOME/cli.js\" whoami   |   node \"$MOYE_HOME/cli.js\" discover --capability translate"
