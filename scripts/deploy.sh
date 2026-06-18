#!/usr/bin/env bash
# Обновление production на сервере (Docker).
# Использование: из корня репозитория — bash scripts/deploy.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

load_env_port() {
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi
  HOST_PORT="${PORT:-3000}"
}

wait_for_health() {
  local url="http://127.0.0.1:${HOST_PORT}/health"
  local attempt
  for attempt in $(seq 1 45); do
    if curl -sf --max-time 3 "$url" >/dev/null 2>&1; then
      echo "==> HTTP готов (попытка ${attempt}): ${url}"
      return 0
    fi
    sleep 2
  done
  echo "==> HTTP не ответил за ~90 с: ${url}" >&2
  echo "==> полные логи бота:" >&2
  docker compose logs --tail=120 bot >&2 || true
  return 1
}

echo "==> git pull"
git fetch origin main
git checkout main
git checkout -- dist/ 2>/dev/null || true
git clean -fd dist/ 2>/dev/null || true
git pull --ff-only origin main

echo "==> текущий коммит:"
git log -1 --oneline

echo "==> docker compose build & recreate"
docker compose down
docker compose up -d --build --force-recreate

echo "==> статус контейнера:"
docker compose ps

load_env_port

echo "==> ожидание готовности /health (порт ${HOST_PORT})..."
wait_for_health

echo "==> последние логи:"
docker compose logs --tail=40 bot

echo ""
echo "==> проверка miniapp (все 3 файла обязательны):"
for path in /miniapp /miniapp/app.js /miniapp/styles.css; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${HOST_PORT}${path}" 2>/dev/null || echo 000)"
  echo "  ${path} -> HTTP ${code}"
done
curl -sS --max-time 5 "http://127.0.0.1:${HOST_PORT}/health" && echo ""
echo ""
echo "Готово. Если не 200 — смотрите: docker compose logs -f bot (BOT_TOKEN, WEBHOOK_URL, ADMIN_CHAT_ID)."
