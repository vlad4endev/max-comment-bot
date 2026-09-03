#!/bin/sh
# Скачивает официальный клиент Hysteria2.
# GitHub с части сетей (и из Docker) недоступен — перебираем прямую ссылку и зеркала.
# Использование: sh scripts/install-hysteria.sh [путь-назначения]
set -eu

VERSION="${HYSTERIA_VERSION:-app/v2.12.2}"
DEST="${1:-}"
UA="max-comment-bot-hysteria"

os=$(uname -s | tr 'A-Z' 'a-z')
if [ -n "${TARGETARCH:-}" ]; then
  arch="${TARGETARCH}"
else
  arch=$(uname -m)
fi
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *)
    echo "Нет готового клиента Hysteria2 для arch=${arch}" >&2
    exit 1
    ;;
esac
case "$os" in
  linux) filename="hysteria-linux-${arch}" ;;
  darwin) filename="hysteria-darwin-${arch}" ;;
  mingw*|msys*|cygwin*|windows*) filename="hysteria-windows-${arch}.exe" ;;
  *)
    echo "Нет готового клиента Hysteria2 для os=${os}" >&2
    exit 1
    ;;
esac

if [ -z "$DEST" ]; then
  DEST="$(pwd)/bin/hysteria"
  case "$filename" in
    *.exe) DEST="${DEST}.exe" ;;
  esac
fi

if [ -x "$DEST" ]; then
  echo "hysteria already at ${DEST}"
  exit 0
fi

rel="hysteria/releases/download/${VERSION}/${filename}"
latest="hysteria/releases/latest/download/${filename}"

# shellcheck disable=SC2086
set -- \
  "https://github.com/HyNetworks/${rel}" \
  "https://github.com/apernet/${rel}" \
  "https://github.com/apernet/${latest}" \
  "https://ghfast.top/https://github.com/HyNetworks/${rel}" \
  "https://gh-proxy.com/https://github.com/HyNetworks/${rel}" \
  "https://ghproxy.net/https://github.com/HyNetworks/${rel}" \
  "https://mirror.ghproxy.com/https://github.com/HyNetworks/${rel}" \
  "https://gitproxy.click/https://github.com/HyNetworks/${rel}"

mkdir -p "$(dirname "$DEST")"
tmp="${DEST}.tmp"
rm -f "$tmp"

download() {
  url=$1
  echo "hysteria download: ${url}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -4 --connect-timeout 15 --max-time 180 -A "$UA" -o "$tmp" "$url" \
      || curl -fsSL --connect-timeout 15 --max-time 180 -A "$UA" -o "$tmp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -4 -T 180 -O "$tmp" "$url" \
      || wget -q -T 180 -O "$tmp" "$url"
  else
    echo "нужен curl или wget" >&2
    return 1
  fi
}

ok=0
for url in "$@"; do
  if download "$url"; then
    size=$(wc -c < "$tmp" | tr -d ' ')
    if [ "$size" -gt 1000000 ]; then
      ok=1
      break
    fi
    echo "слишком маленький файл (${size} байт), пробую следующее зеркало"
  else
    echo "fail: ${url}" >&2
  fi
  rm -f "$tmp"
done

if [ "$ok" != 1 ]; then
  echo "Не удалось скачать ${filename}. Положите бинарник в ${DEST} или задайте HYSTERIA_BIN." >&2
  exit 1
fi

chmod 755 "$tmp"
mv "$tmp" "$DEST"
if [ "$os" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
fi
echo "installed ${DEST} (${size} bytes)"
