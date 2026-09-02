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

# bash читает скрипт в буфер: git reset обновляет файл на диске, но дальше
# всё равно выполняется старая копия (отсюда "no such service: never" после 31206f7).
# После sync всегда перезапускаемся с актуальным scripts/deploy.sh.
if [[ "${DEPLOY_SELF_REEXEC:-}" != "1" ]]; then
  echo "==> git sync (origin/main)"
  git fetch origin main
  git checkout main

  LOCAL_HEAD="$(git rev-parse HEAD)"
  REMOTE_HEAD="$(git rev-parse origin/main)"
  echo "==> было локально:  ${LOCAL_HEAD:0:7} $(git log -1 --oneline "${LOCAL_HEAD}" 2>/dev/null | cut -d' ' -f2- || true)"
  echo "==> на origin/main: ${REMOTE_HEAD:0:7} $(git log -1 --oneline "${REMOTE_HEAD}" 2>/dev/null | cut -d' ' -f2- || true)"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "==> локальные изменения в репозитории (сброс до origin/main):"
    git status -sb || true
  fi

  # Production-сервер: код только из git, локальные правки в src/dist не сохраняем.
  git reset --hard origin/main
  git clean -fd dist/ 2>/dev/null || true
  git update-index --no-assume-unchanged --no-skip-worktree scripts/deploy.sh 2>/dev/null || true
  git checkout -f HEAD -- scripts/deploy.sh

  echo "==> перезапуск scripts/deploy.sh с коммита $(git rev-parse --short HEAD)"
  GIT_COMMIT="$(git rev-parse HEAD)"
  export DEPLOY_SELF_REEXEC=1 LOCAL_HEAD GIT_COMMIT
  exec bash "$ROOT/scripts/deploy.sh"
fi

export GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse HEAD)}"
echo "==> деплой коммита:"
git log -1 --oneline
echo "==> GIT_COMMIT=${GIT_COMMIT}"

if [[ "${LOCAL_HEAD:-}" == "${GIT_COMMIT}" && "${DEPLOY_FORCE_REBUILD:-}" != "1" ]]; then
  echo "==> git HEAD не изменился — для пересборки образа всё равно пробуем build (GIT_COMMIT в Dockerfile)"
fi

ensure_node_base_image() {
  if docker image inspect node:22-alpine >/dev/null 2>&1; then
    echo "==> node:22-alpine уже есть локально — pull не нужен"
    return 0
  fi
  echo "==> нет node:22-alpine — пробую mirror.gcr.io"
  if docker pull mirror.gcr.io/library/node:22-alpine; then
    docker tag mirror.gcr.io/library/node:22-alpine node:22-alpine
    return 0
  fi
  echo "==> GCR недоступен — пробую Docker Hub" >&2
  docker pull node:22-alpine
}

echo "==> docker build max-comment-bot:latest (бот не останавливаем, пока образ не готов)"
ensure_node_base_image
# compose build --pull is boolean; "--pull never" becomes service name "never".
# Собираем Dockerfile напрямую — локальный node:22-alpine, без compose build.
BUILD_ARGS=(--build-arg "GIT_COMMIT=${GIT_COMMIT}" -t max-comment-bot:latest)
if [[ "${DEPLOY_NO_CACHE:-}" == "1" ]]; then
  BUILD_ARGS+=(--no-cache)
  echo "==> DEPLOY_NO_CACHE=1 — полная пересборка образа"
fi
echo "==> docker build ${BUILD_ARGS[*]} ."
command docker build "${BUILD_ARGS[@]}" .

echo "==> пересоздаю только контейнер бота"
UP_ARGS=(-d --force-recreate --no-deps --no-build)
if docker compose up --help 2>/dev/null | grep -Eq -- '--pull[[:space:]].*never'; then
  UP_ARGS+=(--pull never)
fi
echo "==> docker compose up ${UP_ARGS[*]} bot"
if ! command docker compose up "${UP_ARGS[@]}" bot; then
  echo "==> recreate не удался — поднимаю предыдущий контейнер" >&2
  command docker compose up -d || true
  exit 1
fi
docker compose up -d redis >/dev/null 2>&1 || true
if docker compose config --services 2>/dev/null | grep -qx wg-telegram; then
  echo "==> поднимаю wg-telegram (профиль telegram-vpn)"
  docker compose up -d --build wg-telegram || true
fi

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
if [[ -n "$AUTOPOST_JS" ]] && echo "$AUTOPOST_JS" | grep -qE 'single-form-v3|AP_UI_BUILD'; then
  echo "  /admin/assets/autoposts.js -> OK"
elif [[ -n "$AUTOPOST_JS" ]] && echo "$AUTOPOST_JS" | grep -q 'updateModalPreview'; then
  echo "  /admin/assets/autoposts.js -> частично (старая сборка)" >&2
  exit 1
else
  echo "  /admin/assets/autoposts.js -> СТАРАЯ ВЕРСИЯ или недоступен" >&2
  echo "  Пересоберите образ: DEPLOY_NO_CACHE=1 bash scripts/deploy.sh" >&2
  exit 1
fi
ADMIN_HTML="$(docker compose exec -T bot sh -c 'cat admin-panel/admin.html' 2>/dev/null || true)"
if [[ -n "$ADMIN_HTML" ]] && echo "$ADMIN_HTML" | grep -q 'autoposts.js'; then
  echo "  admin-panel/admin.html -> подключает autoposts.js"
else
  echo "  admin-panel/admin.html -> не найден autoposts.js (проверьте admin-panel/admin.html в образе)" >&2
fi

echo ""
echo "==> проверка miniapp (все 3 файла обязательны):"
for path in /miniapp /miniapp/app.js /miniapp/styles.css; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${HOST_PORT}${path}" 2>/dev/null || echo 000)"
  echo "  ${path} -> HTTP ${code}"
done
curl -sS --max-time 5 "http://127.0.0.1:${HOST_PORT}/health" && echo ""

echo ""
echo "==> проверка версии кода в контейнере:"
docker compose exec -T bot sh -c '
  if test -f dist/services/tgPostDeletionWatcher.js; then
    echo "  tgPostDeletionWatcher.js -> OK"
  else
    echo "  tgPostDeletionWatcher.js -> MISSING (старый образ? DEPLOY_NO_CACHE=1 bash scripts/deploy.sh)" >&2
    exit 1
  fi
'

echo ""
echo "Готово. Если не 200 — смотрите: docker compose logs -f bot (BOT_TOKEN, WEBHOOK_URL, ADMIN_CHAT_ID)."
echo "Принудительная пересборка: DEPLOY_NO_CACHE=1 bash scripts/deploy.sh"
