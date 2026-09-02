#!/bin/sh
set -eu

CONF="${WG_CONF:-/config/wgtg.conf}"
IFACE="${WG_IFACE:-wgtg}"
SOCKS_PORT="${SOCKS_PORT:-1080}"

if [ ! -f "$CONF" ]; then
  echo "нет конфига $CONF — выполните bash scripts/wg-telegram-genkeys.sh <IP_VPS>" >&2
  exit 1
fi

if grep -q 'REPLACE_' "$CONF"; then
  echo "$CONF ещё с плейсхолдерами REPLACE_* — заполните ключи и Endpoint" >&2
  exit 1
fi

mkdir -p /etc/wireguard
cp "$CONF" "/etc/wireguard/${IFACE}.conf"
chmod 600 "/etc/wireguard/${IFACE}.conf"

wg-quick down "$IFACE" 2>/dev/null || true
wg-quick up "$IFACE"

echo "==> ${IFACE} поднят"
wg show "$IFACE"

shutdown() {
  echo "==> останавливаю ${IFACE}"
  kill "$SOCKS_PID" 2>/dev/null || true
  wg-quick down "$IFACE" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

microsocks -i 0.0.0.0 -p "$SOCKS_PORT" &
SOCKS_PID=$!
echo "==> SOCKS5 слушает 0.0.0.0:${SOCKS_PORT}"

wait "$SOCKS_PID"
