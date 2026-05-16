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
echo "Готово. Проверка: curl -sS http://127.0.0.1:\${PORT:-3000}/health"
echo "Mini App: откройте /miniapp/index.html и при необходимости перезапустите Mini App в MAX."
