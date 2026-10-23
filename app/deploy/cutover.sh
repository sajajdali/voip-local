#!/usr/bin/env bash
# Swap day: give this machine the old Issabel server's network identity, then power off.
# After it boots in the old server's place (same cable), phones and the operator trunk find it unchanged.
#
#   sudo bash /opt/callcenter/deploy/cutover.sh prepare    # write network config + TLS cert, then power off
#   sudo bash /opt/callcenter/deploy/cutover.sh rollback   # (from the console) return to DHCP on the test network
#   sudo bash /opt/callcenter/deploy/cutover.sh check      # after boot: network, trunk, phones, services
set -euo pipefail
NIC=eno1
OLD_MAC=b4:b5:2f:cd:8b:71          # old server's eth0 (the operator may only accept this MAC)
LAN_IP=192.168.0.254/24
LAN_GW=192.168.0.1
TRUNK_IP=10.198.40.222/30
TRUNK_GW=10.198.40.221
OPERATOR=10.153.101.175
BK=/etc/netplan/backup-before-cutover

case "${1:-}" in
prepare)
  mkdir -p $BK
  for f in /etc/netplan/*.yaml; do [ -e "$f" ] && mv "$f" $BK/; done
  cat > /etc/netplan/01-callcenter.yaml <<NET
network:
  version: 2
  ethernets:
    $NIC:
      dhcp4: false
      macaddress: $OLD_MAC
      addresses: [$LAN_IP, $TRUNK_IP]
      routes:
        - to: default
          via: $LAN_GW
        - to: $OPERATOR/32
          via: $TRUNK_GW
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
NET
  chmod 600 /etc/netplan/01-callcenter.yaml
  netplan generate
  # panel certificate valid for the new address
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -keyout /etc/callcenter/tls/key.pem -out /etc/callcenter/tls/cert.pem \
    -subj "/CN=192.168.0.254/O=Aflaki Call Center" -addext "subjectAltName=IP:192.168.0.254,IP:192.168.100.38,DNS:localhost" 2>/dev/null
  echo "Network config written. The machine will now power off. Move it to the old server's cable and power it on."
  sleep 3
  systemctl poweroff
  ;;
rollback)
  rm -f /etc/netplan/01-callcenter.yaml
  [ -d $BK ] && mv $BK/*.yaml /etc/netplan/ 2>/dev/null || true
  netplan apply
  echo "Back on the previous network settings."
  ;;
check)
  ok() { printf '  %-38s %s\n' "$1" "$2"; }
  ip -4 -br addr show $NIC
  ok "operator ($OPERATOR)" "$(ping -c 2 -W 2 $OPERATOR >/dev/null && echo OK || echo 'NO RESPONSE')"
  ok "trunk OPTIONS" "$(asterisk -rx 'pjsip show contacts' | grep trunk-t88886279 | awk '{print $4, $5}')"
  ok "registered phones" "$(asterisk -rx 'pjsip show contacts' | grep -cE '^ +Contact: +[0-9]+/')"
  for s in asterisk callcenter-api nginx postgresql; do ok "$s" "$(systemctl is-active $s)"; done
  ok "panel" "$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/)"
  ;;
*) echo "usage: $0 prepare|rollback|check"; exit 1 ;;
esac
