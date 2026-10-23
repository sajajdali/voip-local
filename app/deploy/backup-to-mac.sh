#!/usr/bin/env bash
# Full encrypted backup of the call-center server onto this Mac.
#   database (pg_dump) + /etc/callcenter (env, TLS, passwords) + /etc/asterisk + sound files + music on hold
# The archive is streamed over SSH and encrypted HERE (AES-256, PBKDF2) — nothing unencrypted is written to disk.
# Call recordings are not included (too large; history not required).
#
#   app/deploy/backup-to-mac.sh            # make a backup now
# Passphrase: ~/.aflaki-backup-pass (created on first run). Keep a copy in a password manager:
# without it the backups cannot be opened.
set -euo pipefail
HOST=${CC_HOST:-sajjad@2.rokhvanak.ir}
PORT=${CC_PORT:-6280}
DIR=${CC_BACKUP_DIR:-$HOME/Backups/aflaki-callcenter}
PASS=$HOME/.aflaki-backup-pass
KEEP=${CC_KEEP:-30}
mkdir -p "$DIR"
if [ ! -s "$PASS" ]; then
  umask 077; openssl rand -base64 33 | tr -d '\n' > "$PASS"
  echo "Created backup passphrase file: $PASS (copy it to your password manager!)"
fi
OUT="$DIR/callcenter-$(date +%Y%m%d-%H%M%S).tar.gz.enc"
ssh -o BatchMode=yes -o ConnectTimeout=20 -p "$PORT" "$HOST" 'sudo bash -s' <<'REMOTE' | openssl enc -aes-256-cbc -pbkdf2 -iter 300000 -salt -pass file:"$PASS" -out "$OUT.part"
set -euo pipefail
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
sudo -u postgres pg_dump -Fc callcenter > "$T/callcenter.pgdump"
date -Is > "$T/created-at.txt"
tar czf - -C "$T" callcenter.pgdump created-at.txt \
  -C / etc/callcenter etc/asterisk var/lib/asterisk/sounds/custom var/lib/asterisk/moh-cc \
  etc/netplan/01-callcenter.yaml etc/fail2ban/jail.local etc/systemd/system/callcenter-api.service etc/systemd/system/asterisk.service.d \
  etc/nginx/sites-available/callcenter 2>/dev/null
REMOTE
mv "$OUT.part" "$OUT"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
# keep the newest $KEEP backups
ls -1t "$DIR"/callcenter-*.tar.gz.enc 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
