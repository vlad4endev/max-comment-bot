# Клиент WireGuard только для этого проекта (интерфейс wgtg).
# Не использует wg0 / 51820 — они уже заняты другим проектом на хосте.
ARG ALPINE_IMAGE=alpine:3.21
FROM ${ALPINE_IMAGE}

RUN apk add --no-cache \
    bash \
    wireguard-tools \
    iptables \
    iproute2 \
    microsocks \
    curl

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 1080

ENTRYPOINT ["/entrypoint.sh"]
