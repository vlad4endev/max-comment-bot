#!/usr/bin/env bash
# Stops a duplicate max-comment-bot Node process (e.g. s6-supervise in nginx-proxy)
# that polls the same Telegram token and causes HTTP 409 on getUpdates.
set -euo pipefail

echo "=== Processes matching max-comment-bot / getUpdates ==="
ps aux | grep -E '[n]ode.*max-comment-bot|[s]6-supervise.*backend' || true

echo ""
echo "=== Docker containers (nginx-proxy, max-comment-bot) ==="
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | grep -E 'nginx|max-comment|proxy' || true

if [[ -f /root/nginx-proxy/docker-compose.yml ]]; then
  echo ""
  echo "=== Volume mounts in /root/nginx-proxy/docker-compose.yml ==="
  grep -n 'max-comment-bot\|volumes:' /root/nginx-proxy/docker-compose.yml || true
fi

ZOMBIE_PIDS=$(pgrep -f '/root/max-comment-bot/.*index\.js' 2>/dev/null || true)
if [[ -z "${ZOMBIE_PIDS}" ]]; then
  echo ""
  echo "No zombie process under /root/max-comment-bot/ found."
  exit 0
fi

echo ""
echo "Zombie PIDs: ${ZOMBIE_PIDS}"
echo "Kill with: sudo kill ${ZOMBIE_PIDS}"
echo "Then restart nginx-proxy if it respawns the service:"
echo "  cd /root/nginx-proxy && docker compose down && docker compose up -d"
echo "Remove any volume mount of /root/max-comment-bot from docker-compose.yml before restart."
