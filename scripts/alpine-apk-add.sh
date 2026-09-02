#!/bin/sh
# Alpine CDN (dl-cdn.alpinelinux.org) с части сетей висит на TLS/IPv6 минутами.
# Пробуем зеркала с коротким wget-timeout, затем apk add.
set -eu

. /etc/os-release
branch="v${VERSION_ID%.*}"
arch="$(apk --print-arch 2>/dev/null || uname -m)"
ok=0

probe() {
  wget -q -4 -T 12 -O /dev/null "$1" 2>/dev/null \
    || wget -q -T 12 -O /dev/null "$1"
}

for mirror in \
  https://mirror.yandex.ru/mirrors/alpine \
  https://mirror.timeweb.ru/alpine \
  https://mirror.truenetwork.ru/alpine \
  https://dl-cdn.alpinelinux.org/alpine
do
  if probe "${mirror}/${branch}/main/${arch}/APKINDEX.tar.gz"; then
    printf '%s\n' \
      "${mirror}/${branch}/main" \
      "${mirror}/${branch}/community" \
      > /etc/apk/repositories
    echo "apk mirror: ${mirror} (${branch}/${arch})"
    ok=1
    break
  fi
  echo "apk mirror skip: ${mirror}" >&2
done

if [ "$ok" != 1 ]; then
  echo "ни одно apk-зеркало не ответило за 12с" >&2
  exit 1
fi

apk add --no-cache "$@"
