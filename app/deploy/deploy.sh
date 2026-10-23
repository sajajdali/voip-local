#!/usr/bin/env bash
# Build locally and deploy to the server. Usage: deploy/deploy.sh [user@host]
set -euo pipefail
HOST=${1:-sajjad@192.168.100.38}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
(cd "$ROOT/web" && npm run build)
rsync -az --delete --exclude node_modules --exclude 'api/dist' --exclude '.DS_Store' "$ROOT/" "$HOST:/opt/callcenter/"
ssh "$HOST" 'set -e; cd /opt/callcenter/api && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null &&
  sudo bash -c "set -a; . /etc/callcenter/api.env; set +a; cd /opt/callcenter/api && npx prisma db push --skip-generate --accept-data-loss >/dev/null" &&
  sudo systemctl restart callcenter-api && sleep 3 && curl -sk https://127.0.0.1/api/health'
