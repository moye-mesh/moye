#!/usr/bin/env bash
# ADR-0006 workstream A: run this once for each additional git forge mirror (GitLab, Codeberg,
# self-hosted Gitea, ...) after creating an empty repo there. It adds the mirror as an extra PUSH
# url on `origin`, so a single `git push origin main` fans out to every configured mirror at once --
# no separate `git push <mirror>` needed, and no forgetting to push to one of them.
#
# Usage: ./a2a/scripts/add-mirror.sh <name> <url>
#   e.g. ./a2a/scripts/add-mirror.sh gitlab git@gitlab.com:youruser/MoyeAI.git
#        ./a2a/scripts/add-mirror.sh codeberg git@codeberg.org:youruser/MoyeAI.git
#
# Run `git remote -v` afterwards to see all configured push targets under `origin`.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

name="${1:?Usage: add-mirror.sh <name> <git-url>}"
url="${2:?Usage: add-mirror.sh <name> <git-url>}"

# `git remote set-url --add --push origin <url>` appends an additional push destination without
# touching the existing fetch url or any previously-added push urls.
git remote set-url --add --push origin "$url"
echo "[add-mirror] added '$name' ($url) as an extra push target on origin."
echo "[add-mirror] current origin push urls:"
git remote -v | grep '^origin.*push'
echo ""
echo "[add-mirror] next: git push origin main   # now pushes to every mirror listed above"
