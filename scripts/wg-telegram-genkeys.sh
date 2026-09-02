#!/usr/bin/env bash
# Генерирует ключи и заполняет deploy/wireguard/*.conf (не коммитятся).
# Не трогает /etc/wireguard/wg0.conf на хосте.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/deploy/wireguard"
ENDPOINT_HOST="${1:-}"

if ! command -v wg >/dev/null 2>&1; then
  echo "нужен wg: apt install wireguard / brew install wireguard-tools" >&2
  exit 1
fi

SERVER_PRIV="$(wg genkey)"
SERVER_PUB="$(printf '%s' "$SERVER_PRIV" | wg pubkey)"
CLIENT_PRIV="$(wg genkey)"
CLIENT_PUB="$(printf '%s' "$CLIENT_PRIV" | wg pubkey)"

umask 077

sed \
  -e "s|REPLACE_SERVER_PRIVATE_KEY|${SERVER_PRIV}|g" \
  -e "s|REPLACE_CLIENT_PUBLIC_KEY|${CLIENT_PUB}|g" \
  "$DIR/server.conf.example" >"$DIR/server.conf"

CLIENT_OUT="$DIR/wgtg.conf"
sed \
  -e "s|REPLACE_CLIENT_PRIVATE_KEY|${CLIENT_PRIV}|g" \
  -e "s|REPLACE_SERVER_PUBLIC_KEY|${SERVER_PUB}|g" \
  "$DIR/wgtg.conf.example" >"$CLIENT_OUT"

if [[ -n "$ENDPOINT_HOST" ]]; then
  sed -i.bak "s|REPLACE_FOREIGN_VPS_IP|${ENDPOINT_HOST}|g" "$CLIENT_OUT"
  rm -f "${CLIENT_OUT}.bak"
fi

echo "server public:  ${SERVER_PUB}"
echo "client public:  ${CLIENT_PUB}"
echo
echo "записано:"
echo "  $DIR/server.conf   → зарубежный VPS: /etc/wireguard/wgtg.conf"
echo "  $DIR/wgtg.conf     → skypath, том контейнера wg-telegram"
if [[ -z "$ENDPOINT_HOST" ]]; then
  echo
  echo "подставьте IP зарубежного VPS в wgtg.conf (Endpoint) или:"
  echo "  bash scripts/wg-telegram-genkeys.sh <FOREIGN_VPS_IP>"
fi
echo
echo "на зарубежном VPS замените eth0 в PostUp/PostDown на реальный интерфейс."
echo "хостовый wg0 другого проекта не меняйте."
