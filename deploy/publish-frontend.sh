#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${GROKIQ_FRONTEND_ROOT:-/var/www/grok-iq}"

cd "$root/frontend"
npx vite build

install -d -m 755 "$dest"
rsync -a --delete dist/ "$dest/"
if id caddy >/dev/null 2>&1; then
  chown -R caddy:caddy "$dest"
fi

echo "Published $root/frontend/dist -> $dest"
