#!/usr/bin/env bash
# Проверка туннеля Telegram на skypath. Чужой wg0 не трогает.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> хостовые интерфейсы WireGuard (должен остаться чужой wg0):"
wg show 2>/dev/null || echo "(на хосте wg не в PATH или нет интерфейсов — это нормально, если чужой туннель в другом неймспейсе)"

echo
echo "==> контейнер wg-telegram:"
docker compose ps wg-telegram || true

echo
echo "==> handshake внутри контейнера:"
docker compose exec -T wg-telegram wg show wgtg || {
  echo "контейнер не запущен. В .env: COMPOSE_PROFILES=telegram-vpn" >&2
  exit 1
}

echo
echo "==> api.telegram.org через SOCKS контейнера:"
docker compose exec -T wg-telegram \
  curl -sS --max-time 15 -o /dev/null -w "wg-telegram: HTTP %{http_code} time %{time_total}\n" \
  --proxy socks5h://127.0.0.1:1080 https://api.telegram.org || {
  echo "SOCKS/Telegram недоступны" >&2
  exit 1
}

echo
echo "==> api.telegram.org из контейнера бота (через TELEGRAM_PROXY_URL):"
docker compose exec -T bot node -e "
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const url = process.env.TELEGRAM_PROXY_URL || 'socks5://wg-telegram:1080';
const agent = new SocksProxyAgent(url.replace(/^socks5:\\/\\//,'socks5h://'));
https.get('https://api.telegram.org', { agent, timeout: 15000 }, (r) => {
  console.log('bot: status', r.statusCode);
  process.exit(0);
}).on('error', (e) => {
  console.error('bot: error', e.code || e.message);
  process.exit(1);
});
"
