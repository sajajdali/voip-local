#!/usr/bin/env bash
# Restore a full encrypted backup (made by backup-to-mac.sh) onto a freshly installed server.
# Order on a new machine (see RESTORE.md):
#   1) install Ubuntu, create user sajjad, passwordless sudo, SSH key
#   2) sudo bash install-server.sh          (packages + Asterisk 22)
#   3) app/deploy/deploy.sh <host>          (code)   — or rsync + build manually
#   4) app/deploy/restore-from-backup.sh <backup.tar.gz.enc> [user@host] [port]
set -euo pipefail
FILE=${1:?usage: restore-from-backup.sh <backup.tar.gz.enc> [user@host] [port]}
HOST=${2:-sajjad@2.rokhvanak.ir}
PORT=${3:-6280}
PASS=${CC_PASS_FILE:-$HOME/.aflaki-backup-pass}
openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 -pass file:"$PASS" -in "$FILE" | ssh -p "$PORT" "$HOST" 'cat > /tmp/cc-restore.tgz'
ssh -p "$PORT" "$HOST" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
T=$(mktemp -d); trap 'rm -rf "$T" /tmp/cc-restore.tgz' EXIT
tar xzf /tmp/cc-restore.tgz -C "$T"
echo "backup from: $(cat "$T/created-at.txt")"
systemctl stop callcenter-api asterisk || true
# configuration, secrets, sounds
cp -a "$T/etc/callcenter" /etc/ ; cp -a "$T/etc/asterisk/." /etc/asterisk/
mkdir -p /var/lib/asterisk/sounds/custom /var/lib/asterisk/moh-cc
cp -a "$T/var/lib/asterisk/sounds/custom/." /var/lib/asterisk/sounds/custom/
[ -d "$T/var/lib/asterisk/moh-cc" ] && cp -a "$T/var/lib/asterisk/moh-cc/." /var/lib/asterisk/moh-cc/
[ -f "$T/etc/fail2ban/jail.local" ] && cp -a "$T/etc/fail2ban/jail.local" /etc/fail2ban/ || true
[ -d "$T/etc/systemd/system/asterisk.service.d" ] && cp -a "$T/etc/systemd/system/asterisk.service.d" /etc/systemd/system/ || true
[ -f "$T/etc/systemd/system/callcenter-api.service" ] && cp -a "$T/etc/systemd/system/callcenter-api.service" /etc/systemd/system/ || true
[ -f "$T/etc/nginx/sites-available/callcenter" ] && cp -a "$T/etc/nginx/sites-available/callcenter" /etc/nginx/sites-available/ && ln -sf /etc/nginx/sites-available/callcenter /etc/nginx/sites-enabled/callcenter && rm -f /etc/nginx/sites-enabled/default
# network config is restored but NOT applied automatically (apply with: netplan apply)
[ -f "$T/etc/netplan/01-callcenter.yaml" ] && cp -a "$T/etc/netplan/01-callcenter.yaml" /etc/callcenter/netplan-01-callcenter.yaml.from-backup || true
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk/sounds/custom /var/lib/asterisk/moh-cc
chgrp asterisk /etc/callcenter/api.env; chmod 640 /etc/callcenter/api.env
# database (same password as in the restored api.env)
set -a; . /etc/callcenter/api.env; set +a
DBP=$(echo "$DATABASE_URL" | sed -E 's#.*callcenter:([^@]+)@.*#\1#')
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='callcenter'" | grep -q 1 || sudo -u postgres psql -c "CREATE ROLE callcenter LOGIN PASSWORD '$DBP'"
sudo -u postgres psql -c "ALTER ROLE callcenter PASSWORD '$DBP'" >/dev/null
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='callcenter'" | grep -q 1 && sudo -u postgres dropdb callcenter
sudo -u postgres createdb -O callcenter -E UTF8 -T template0 callcenter
sudo -u postgres pg_restore -d callcenter --no-owner --role=callcenter "$T/callcenter.pgdump"
systemctl daemon-reload
systemctl restart asterisk; sleep 4; systemctl restart callcenter-api nginx fail2ban 2>/dev/null || true
echo "RESTORE_DONE"
REMOTE
