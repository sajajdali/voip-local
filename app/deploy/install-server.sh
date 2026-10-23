#!/usr/bin/env bash
# Installs system prerequisites and builds Asterisk 22 LTS from source.
# Run as: sudo bash install-server.sh
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y build-essential git curl wget rsync pkg-config autoconf automake libtool \
  libssl-dev libncurses-dev libnewt-dev libxml2-dev libsqlite3-dev uuid-dev libjansson-dev \
  libedit-dev libsrtp2-dev libpq-dev unixodbc-dev libcurl4-openssl-dev libspeex-dev libspeexdsp-dev \
  libogg-dev libvorbis-dev libopus-dev bzip2 patch xmlstarlet \
  postgresql redis-server nginx nodejs npm ffmpeg sox lame openssl ufw

# ---- Asterisk 22 ----
if ! command -v asterisk >/dev/null; then
  id asterisk >/dev/null 2>&1 || useradd -r -d /var/lib/asterisk -s /usr/sbin/nologin asterisk
  mkdir -p /usr/src/asterisk-build && cd /usr/src/asterisk-build
  [ -f asterisk-22-current.tar.gz ] || wget -q https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz
  rm -rf asterisk-22.*/ && tar xzf asterisk-22-current.tar.gz
  cd asterisk-22.*/
  ./configure --with-pjproject-bundled --with-jansson-bundled --libdir=/usr/lib64 || ./configure --with-pjproject-bundled --libdir=/usr/lib64
  make menuselect.makeopts
  menuselect/menuselect --enable cdr_pgsql --enable cel_pgsql --enable res_config_pgsql \
    --enable CORE-SOUNDS-EN-WAV --enable MOH-OPSOUND-WAV --enable EXTRA-SOUNDS-EN-WAV \
    --disable BUILD_NATIVE menuselect.makeopts
  make -j"$(nproc)"
  make install
  make samples
  make install-logrotate || true
  echo /usr/lib64 > /etc/ld.so.conf.d/asterisk.conf && ldconfig
  cp contrib/systemd/asterisk.service /etc/systemd/system/asterisk.service 2>/dev/null || true
fi

sed -i 's/^;\?runuser.*/runuser = asterisk/; s/^;\?rungroup.*/rungroup = asterisk/' /etc/asterisk/asterisk.conf
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk 2>/dev/null || true
systemctl daemon-reload
systemctl enable asterisk
systemctl restart asterisk || true

systemctl enable --now postgresql redis-server nginx
echo INSTALL_DONE
