#!/usr/bin/env bash
# Обновление production на сервере (Docker).
# Использование: из корня репозитория — bash scripts/deploy.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> git pull"
git fetch origin main
git checkout main
git pull --ff-only origin main

echo "==> текущий коммит:"
git log -1 --oneline

echo "==> docker compose build & recreate"
docker compose down
docker compose up -d --build --force-recreate

echo "==> статус контейнера:"
docker compose ps

echo "==> последние логи:"
docker compose logs --tail=40 bot

echo ""
echo "==> проверка miniapp (все 3 файла обязательны):"
PORT="${PORT:-3000}"
for path in /miniapp/ /miniapp/app.js /miniapp/styles.css; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${path}" || echo 000)"
  echo "  ${path} -> HTTP ${code}"
done
curl -sS "http://127.0.0.1:${PORT}/health" && echo ""
echo ""
echo "Готово. Если app.js или styles.css не 200 — выполните снова: docker compose up -d --build"
