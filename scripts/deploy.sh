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
echo "==> проверка admin autoposts (патч модалки):"
AUTOPOST_JS="$(curl -sS --max-time 8 "http://127.0.0.1:${HOST_PORT}/admin/assets/autoposts.js" 2>/dev/null || true)"
if [[ -n "$AUTOPOST_JS" ]] && echo "$AUTOPOST_JS" | grep -q 'updateModalPreview'; then
  echo "  /admin/assets/autoposts.js -> OK (updateModalPreview найден)"
else
  echo "  /admin/assets/autoposts.js -> СТАРАЯ ВЕРСИЯ или недоступен" >&2
  echo "  Пересоберите образ: docker compose build --no-cache bot && docker compose up -d --force-recreate" >&2
fi
ADMIN_HTML="$(curl -sS --max-time 8 "http://127.0.0.1:${HOST_PORT}/admin/login" 2>/dev/null || true)"
if [[ -n "$ADMIN_HTML" ]] && echo "$ADMIN_HTML" | grep -q 'autoposts.js'; then
  echo "  admin HTML -> подключает autoposts.js"
else
  echo "  admin HTML -> не найден autoposts.js (проверьте admin-panel/admin.html в образе)" >&2
fi

echo ""
echo "==> проверка miniapp (все 3 файла обязательны):"
for path in /miniapp /miniapp/app.js /miniapp/styles.css; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${HOST_PORT}${path}" 2>/dev/null || echo 000)"
  echo "  ${path} -> HTTP ${code}"
done
curl -sS --max-time 5 "http://127.0.0.1:${HOST_PORT}/health" && echo ""
echo ""
echo "Готово. Если не 200 — смотрите: docker compose logs -f bot (BOT_TOKEN, WEBHOOK_URL, ADMIN_CHAT_ID)."
