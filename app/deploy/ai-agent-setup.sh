#!/bin/bash
# One-time setup of the AI receptionist service on the call-center server (run as root).
# Settings (model, keys, transfer) are edited in the panel: Settings → AI receptionist.
set -euo pipefail
APP=/opt/callcenter

apt-get install -y -q python3-websocket >/dev/null
id callcenter-ai >/dev/null 2>&1 || useradd --system --home-dir /var/lib/callcenter-ai --shell /usr/sbin/nologin callcenter-ai
usermod -aG asterisk callcenter-ai

# state shared by Asterisk (asterisk user), the API (asterisk user) and the bridge (callcenter-ai, group asterisk)
install -d -o callcenter-ai -g asterisk -m 2770 /var/lib/callcenter-ai /var/lib/callcenter-ai/callers /var/lib/callcenter-ai/transfers /var/lib/callcenter-ai/transcripts
# the API writes the bridge's environment files here
install -d -o asterisk -g asterisk -m 0750 /etc/callcenter/ai

install -o asterisk -g asterisk -m 0644 "$APP/ai-agent/sounds/ai-unavailable-fa.wav" /var/lib/asterisk/sounds/custom/ai-unavailable-fa.wav

cp "$APP"/deploy/systemd/callcenter-ai.service "$APP"/deploy/systemd/callcenter-ai-reload.path "$APP"/deploy/systemd/callcenter-ai-reload.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now callcenter-ai-reload.path
systemctl enable callcenter-ai.service
systemctl restart callcenter-ai.service || true
systemctl --no-pager --lines=0 status callcenter-ai.service || true
